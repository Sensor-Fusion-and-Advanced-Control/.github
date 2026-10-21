'use strict';

const STORAGE_KEY = 'lab-inventory:v1:working-copy';
const DATA_VERSION = 1;
const MAX_TEXT_LENGTH = 200;
const FILENAME = 'inventory.json';

class ValidationError extends Error {}

const state = {
  items: [],
  dirty: false,
  source: 'none',
  savedAt: null,
  blockedReason: null,
  localCopyPresent: false,
  canonicalItems: null,
  canonicalFetched: false,
  storageAvailable: true,
  pendingReplacement: null,
};

const elements = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();
  render();

  let local = { status: 'none' };

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      local = parseStoredCopy(raw);
      if (local.status === 'ok') {
        state.items = local.items;
        state.dirty = local.dirty;
        state.source = 'local';
        state.savedAt = local.savedAt;
        state.localCopyPresent = true;
        showNotice(
          'info',
          `Restored the working copy saved in this browser ${local.savedAt ? `on ${formatDate(local.savedAt)}` : 'earlier'}.`,
          { key: 'restored', dismissible: true }
        );
      } else {
        state.blockedReason = 'corrupt-local';
        showNotice(
          'error',
          'The working copy saved in this browser is damaged and was not loaded. Your current data has been left untouched. Download a copy of the raw stored data before discarding it.',
          {
            key: 'corrupt',
            actions: [
              { label: 'Download raw copy', handler: () => downloadRawBackup(local.raw) },
              { label: 'Discard and reload', handler: discardLocalCopy },
            ],
          }
        );
      }
    }
  } catch (error) {
    state.storageAvailable = false;
    showNotice(
      'error',
      'This browser would not let the page read local storage. You can still import and export files, but changes will be lost when you close the page.',
      { key: 'storage' }
    );
  }

  render();

  if (state.blockedReason === 'corrupt-local') {
    return;
  }

  await fetchCanonical(state.localCopyPresent);
}

function cacheElements() {
  for (const id of [
    'notices', 'total-count', 'category-count', 'visible-count', 'save-state', 'saved-at',
    'search', 'category-filter', 'sort-field', 'sort-direction', 'add-button', 'export-button',
    'import-button', 'import-input', 'results-summary', 'item-body', 'item-dialog',
    'item-dialog-title', 'item-form', 'item-id', 'item-name', 'item-category', 'item-location',
    'item-quantity', 'form-error', 'item-submit', 'replace-dialog', 'replace-dialog-title',
    'replace-dialog-message', 'replace-confirm', 'backup-button', 'category-options',
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements.search.addEventListener('input', renderRowsAndCounts);
  elements['category-filter'].addEventListener('change', renderRowsAndCounts);
  elements['sort-field'].addEventListener('change', renderRowsAndCounts);
  elements['sort-direction'].addEventListener('change', renderRowsAndCounts);

  elements['add-button'].addEventListener('click', () => openItemDialog());
  elements['export-button'].addEventListener('click', exportInventory);
  elements['import-button'].addEventListener('click', () => elements['import-input'].click());
  elements['import-input'].addEventListener('change', handleImportSelection);

  elements['item-form'].addEventListener('submit', handleItemSubmit);

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog) dialog.close();
    });
  });

  elements['item-dialog'].addEventListener('close', () => {
    elements['form-error'].hidden = true;
    elements['item-form'].reset();
  });

  elements['backup-button'].addEventListener('click', () => {
    downloadInventory(`inventory-backup-${timestampForFilename()}.json`, state.items);
  });

  elements['replace-confirm'].addEventListener('click', confirmReplacement);

  elements['item-body'].addEventListener('click', handleTableClick);

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && event.newValue && !state.dirty) {
      try {
        const parsed = parseStoredCopy(event.newValue);
        if (parsed.status === 'ok') {
          state.items = parsed.items;
          state.dirty = parsed.dirty;
          state.savedAt = parsed.savedAt;
          render();
          showNotice('info', 'The working copy was updated in another tab.', { key: 'other-tab', dismissible: true });
        }
      } catch (error) {
        /* Ignore storage events caused by other pages. */
      }
    }
  });
}

/* ----------------------------- Data validation ---------------------------- */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateText(value, label) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ValidationError(`${label} is required.`);
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${label} must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateId(value, label) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ValidationError(`${label} is required.`);
  }
  if (trimmed !== value) {
    throw new ValidationError(`${label} must not start or end with spaces.`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${label} must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return value;
}

const ITEM_FIELDS = ['id', 'name', 'category', 'location', 'quantity'];

function validateItem(raw, index) {
  const label = `Item ${index + 1}`;
  if (!isPlainObject(raw)) {
    throw new ValidationError(`${label} must be an object.`);
  }

  const missing = ITEM_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(raw, field));
  if (missing.length > 0) {
    throw new ValidationError(`${label} is missing: ${missing.join(', ')}.`);
  }

  const unknown = Object.keys(raw).filter((field) => !ITEM_FIELDS.includes(field));
  if (unknown.length > 0) {
    throw new ValidationError(`${label} has unknown field(s): ${unknown.join(', ')}.`);
  }

  if (typeof raw.quantity !== 'number' || !Number.isSafeInteger(raw.quantity) || raw.quantity < 0) {
    throw new ValidationError(`${label} quantity must be a whole number of zero or more.`);
  }

  return {
    id: validateId(raw.id, `${label} id`),
    name: validateText(raw.name, `${label} name`),
    category: validateText(raw.category, `${label} category`),
    location: validateText(raw.location, `${label} location`),
    quantity: raw.quantity,
  };
}

function validateInventory(raw) {
  if (!isPlainObject(raw)) {
    throw new ValidationError('The inventory must be a JSON object.');
  }

  const unknown = Object.keys(raw).filter((key) => key !== 'version' && key !== 'items');
  if (unknown.length > 0) {
    throw new ValidationError(`The inventory has unknown field(s): ${unknown.join(', ')}.`);
  }

  if (raw.version !== DATA_VERSION) {
    throw new ValidationError(`The inventory version must be ${DATA_VERSION}.`);
  }

  if (!Array.isArray(raw.items)) {
    throw new ValidationError('The inventory must contain an "items" array.');
  }

  const seenIds = new Set();
  const items = raw.items.map((item, index) => {
    const valid = validateItem(item, index);
    if (seenIds.has(valid.id)) {
      throw new ValidationError(`Duplicate item id "${valid.id}". Item ids must be unique.`);
    }
    seenIds.add(valid.id);
    return valid;
  });

  return items;
}

function parseStoredCopy(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { status: 'corrupt', raw, reason: 'Stored data is not valid JSON.' };
  }

  try {
    if (!isPlainObject(data)) {
      throw new ValidationError('Stored data must be an object.');
    }
    if (data.version !== DATA_VERSION) {
      throw new ValidationError(`Stored data version must be ${DATA_VERSION}.`);
    }
    const items = validateInventory({ version: DATA_VERSION, items: data.items });
    return {
      status: 'ok',
      items,
      dirty: data.dirty === true,
      savedAt: typeof data.savedAt === 'string' ? data.savedAt : null,
    };
  } catch (error) {
    return {
      status: 'corrupt',
      raw,
      reason: error instanceof ValidationError ? error.message : 'Stored data has an unexpected shape.',
    };
  }
}

/* ------------------------------ Load / persist ---------------------------- */

async function fetchCanonical(hasLocalCopy) {
  const url = `${FILENAME}?v=${Date.now()}`;

  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const items = validateInventory(data);

    state.canonicalFetched = true;
    state.canonicalItems = items;

    if (hasLocalCopy) {
      if (inventoriesEqual(items, state.items)) {
        showNotice('info', 'Your working copy matches inventory.json.', { key: 'server', dismissible: true });
      } else {
        showNotice(
          'warning',
          `inventory.json contains ${countLabel(items.length)}, but your browser working copy has ${countLabel(state.items.length)}. Your working copy was not changed.`,
          {
            key: 'server',
            actions: [
              {
                label: 'Review inventory.json',
                handler: () => openReplaceDialog(items, {
                  mode: 'server',
                  title: 'Load inventory.json?',
                  message: `The server file contains ${pluralize(items.length, 'item')}. This will replace the working copy in this browser.`,
                  confirmLabel: 'Load file',
                }),
              },
            ],
          }
        );
      }
      render();
      return;
    }

    state.items = items;
    state.dirty = false;
    state.source = 'server';
    state.blockedReason = null;
    state.savedAt = new Date().toISOString();
    persist();
    render();
    showNotice(
      'info',
      items.length === 0
        ? 'inventory.json is empty. Add your first item or import a file to get started.'
        : `Loaded ${pluralize(items.length, 'item')} from inventory.json.`,
      { key: 'server', dismissible: true }
    );
  } catch (error) {
    if (hasLocalCopy) {
      showNotice(
        'warning',
        'inventory.json could not be loaded from the server. You are working from the copy saved in this browser. Changes still need to be exported when you are done.',
        { key: 'server', dismissible: true }
      );
      render();
      return;
    }

    state.blockedReason = 'fetch-failed';
    state.items = [];
    state.dirty = false;
    showNotice(
      'error',
      fetchFailureMessage(error),
      {
        key: 'server',
        actions: [
          { label: 'Import a file', handler: () => elements['import-input'].click() },
          { label: 'Start empty', handler: startEmptyInventory },
        ],
      }
    );
    render();
  }
}

function fetchFailureMessage(error) {
  const detail = error instanceof Error ? error.message : String(error);
  const isFile = window.location.protocol === 'file:';

  if (error instanceof ValidationError) {
    return `inventory.json was found but rejected: ${detail} Fix the file in the repository or import a valid copy. You can also start with an empty inventory.`;
  }

  if (isFile) {
    return `inventory.json could not be read because the page was opened directly from disk (file://). Browsers block that kind of local file access. Serve the folder with a local web server to load inventory.json automatically, or import a JSON file below and start from an empty inventory. (${detail})`;
  }

  return `inventory.json could not be loaded (${detail}). Check that the file exists next to index.html, or import a JSON file. You can also start with an empty inventory.`;
}

function persist() {
  state.savedAt = new Date().toISOString();
  const payload = {
    version: DATA_VERSION,
    items: state.items,
    dirty: state.dirty,
    source: state.source,
    savedAt: state.savedAt,
  };

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    state.storageAvailable = true;
    clearNotice('storage');
  } catch (error) {
    state.storageAvailable = false;
    showNotice(
      'error',
      'This browser could not save the working copy to local storage. The page still works, but export your inventory before closing it.',
      { key: 'storage' }
    );
  }

  renderSaveState();
}

function startEmptyInventory() {
  state.items = [];
  state.dirty = false;
  state.source = 'empty';
  state.blockedReason = null;
  state.savedAt = new Date().toISOString();
  clearNotice('server');
  persist();
  render();
  showNotice('info', 'Started an empty inventory. Add items, then export when you are done.', {
    key: 'started',
    dismissible: true,
  });
}

function discardLocalCopy() {
  if (!window.confirm('Discard the damaged working copy saved in this browser and reload? Download a raw copy first if you might need it.')) {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    /* Nothing else can be done if storage is blocked. */
  }
  window.location.reload();
}

/* --------------------------------- Mutations ------------------------------ */

function handleItemSubmit(event) {
  event.preventDefault();
  const name = elements['item-name'].value.trim();
  const category = elements['item-category'].value.trim();
  const location = elements['item-location'].value.trim();
  const rawQuantity = elements['item-quantity'].value.trim();
  const editingId = elements['item-id'].value;

  const errors = [];
  if (name === '') errors.push('Name is required.');
  if (name.length > MAX_TEXT_LENGTH) errors.push(`Name must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  if (category === '') errors.push('Category is required.');
  if (category.length > MAX_TEXT_LENGTH) errors.push(`Category must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  if (location === '') errors.push('Location is required.');
  if (location.length > MAX_TEXT_LENGTH) errors.push(`Location must be ${MAX_TEXT_LENGTH} characters or fewer.`);

  let quantity = Number.NaN;
  if (rawQuantity === '') {
    errors.push('Quantity is required.');
  } else if (!/^\d+$/.test(rawQuantity)) {
    errors.push('Quantity must be a whole number of zero or more.');
  } else {
    quantity = Number(rawQuantity);
    if (!Number.isSafeInteger(quantity)) {
      errors.push('Quantity is too large.');
    }
  }

  if (errors.length > 0) {
    showFormError(errors.join(' '));
    return;
  }

  if (editingId) {
    const item = state.items.find((entry) => entry.id === editingId);
    if (!item) {
      showFormError('That item no longer exists. Close the dialog and try again.');
      return;
    }
    item.name = name;
    item.category = category;
    item.location = location;
    item.quantity = quantity;
  } else {
    state.items.push({
      id: createId(),
      name,
      category,
      location,
      quantity,
    });
  }

  state.dirty = true;
  clearNotice('server');
  elements['item-dialog'].close();
  persist();
  render();
  announce(editingId ? `Saved changes to ${name}.` : `Added ${name}.`);
}

function deleteItem(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;

  if (!window.confirm(`Delete "${item.name}"? This removes it from your working copy. Export afterwards to publish the change.`)) {
    return;
  }

  state.items = state.items.filter((entry) => entry.id !== id);
  state.dirty = true;
  clearNotice('server');
  persist();
  render();
  announce(`Deleted ${item.name}.`);
}

function createId() {
  let id;
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    id = window.crypto.randomUUID();
  } else {
    id = `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  while (state.items.some((item) => item.id === id)) {
    id = `item-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  return id;
}

/* ------------------------------ Import / export --------------------------- */

async function handleImportSelection(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  let text;
  try {
    text = await file.text();
  } catch (error) {
    showNotice('error', `The file "${file.name}" could not be read.`, { key: 'import-error' });
    return;
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    showNotice('error', `"${file.name}" is not valid JSON. Nothing was changed.`, { key: 'import-error' });
    return;
  }

  let items;
  try {
    items = validateInventory(raw);
  } catch (error) {
    const reason = error instanceof ValidationError ? error.message : 'The file has an unexpected shape.';
    showNotice('error', `"${file.name}" was rejected: ${reason} Nothing was changed.`, { key: 'import-error' });
    return;
  }

  clearNotice('import-error');
  openReplaceDialog(items, {
    mode: 'import',
    title: 'Import this inventory?',
    message: `"${file.name}" contains ${pluralize(items.length, 'item')}. This browser currently has ${pluralize(state.items.length, 'item')}.`,
    confirmLabel: 'Import and replace',
  });
}

function openReplaceDialog(items, options) {
  state.pendingReplacement = { items, ...options };
  elements['replace-dialog-title'].textContent = options.title;
  elements['replace-dialog-message'].textContent = options.message;
  elements['replace-confirm'].textContent = options.confirmLabel;
  openDialog(elements['replace-dialog']);
}

function confirmReplacement() {
  const pending = state.pendingReplacement;
  if (!pending) return;

  state.items = pending.items.map((item) => ({ ...item }));
  state.dirty = pending.mode === 'import'
    ? !(state.canonicalFetched && inventoriesEqual(state.items, state.canonicalItems || []))
    : false;
  state.source = pending.mode === 'import' ? 'import' : 'server';
  state.blockedReason = null;
  state.pendingReplacement = null;
  elements['replace-dialog'].close();
  clearNotice('server');
  clearNotice('corrupt');
  persist();
  render();

  if (pending.mode === 'import') {
    showNotice(
      'success',
      `Imported ${pluralize(state.items.length, 'item')}. Export when you are ready to replace inventory.json.`,
      { key: 'imported', dismissible: true }
    );
    announce(`Imported ${pluralize(state.items.length, 'item')}.`);
  } else {
    showNotice('success', `Loaded ${pluralize(state.items.length, 'item')} from inventory.json.`, {
      key: 'server',
      dismissible: true,
    });
    announce('Loaded inventory.json.');
  }
}

function exportInventory() {
  if (state.blockedReason) return;
  downloadInventory(FILENAME, state.items);
  state.dirty = false;
  persist();
  render();
  showNotice(
    'success',
    `Exported ${pluralize(state.items.length, 'item')}. Replace inventory.json in the repository with this file to publish the change.`,
    { key: 'exported', dismissible: true }
  );
  announce('Inventory exported.');
}

function downloadInventory(filename, items) {
  downloadJson(filename, { version: DATA_VERSION, items });
}

function downloadRawBackup(raw) {
  const blob = new Blob([raw], { type: 'application/json' });
  triggerDownload(blob, `inventory-raw-backup-${timestampForFilename()}.json`);
}

function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  triggerDownload(blob, filename);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------------- Rendering ------------------------------ */

function render() {
  renderSaveState();
  renderCategoryOptions();
  renderRowsAndCounts();
  updateControls();
}

function renderSaveState() {
  const badge = elements['save-state'];
  badge.classList.remove('badge-ok', 'badge-dirty', 'badge-blocked');

  if (state.blockedReason) {
    badge.textContent = 'Inventory not loaded';
    badge.classList.add('badge-blocked');
  } else if (!state.storageAvailable) {
    badge.textContent = 'Local saving unavailable';
    badge.classList.add('badge-blocked');
  } else if (state.dirty) {
    badge.textContent = 'Changes need export';
    badge.classList.add('badge-dirty');
  } else {
    badge.textContent = 'No changes to export';
    badge.classList.add('badge-ok');
  }

  elements['saved-at'].textContent = state.savedAt ? `Browser copy saved ${formatDate(state.savedAt)}` : '';
}

function renderCategoryOptions() {
  const categories = [...new Set(state.items.map((item) => item.category))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  );

  const previous = elements['category-filter'].value;
  const filter = elements['category-filter'];
  filter.replaceChildren(new Option('All categories', ''));
  for (const category of categories) {
    filter.append(new Option(category, category));
  }
  filter.value = categories.includes(previous) ? previous : '';

  elements['category-options'].replaceChildren(
    ...categories.map((category) => {
      const option = document.createElement('option');
      option.value = category;
      return option;
    })
  );
}

function renderRowsAndCounts() {
  const visible = getVisibleItems();
  const categoryCount = new Set(state.items.map((item) => item.category)).size;

  elements['total-count'].textContent = String(state.items.length);
  elements['category-count'].textContent = String(categoryCount);
  elements['visible-count'].textContent = String(visible.length);

  const activeFilters = elements.search.value.trim() !== '' || elements['category-filter'].value !== '';
  elements['results-summary'].textContent = state.items.length === 0
    ? 'No items in the inventory.'
    : activeFilters
      ? `Showing ${visible.length} of ${pluralize(state.items.length, 'item')} after search and filters.`
      : `Showing all ${pluralize(state.items.length, 'item')}.`;

  const tbody = elements['item-body'];
  tbody.replaceChildren();

  if (visible.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty-cell';

    const message = document.createElement('p');
    message.className = 'empty-title';
    message.textContent = state.items.length === 0
      ? 'No items yet.'
      : 'No items match your search or filters.';

    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = state.items.length === 0
      ? 'Add your first item, or import an inventory.json file.'
      : 'Try a different search or clear the filters.';

    cell.append(message, hint);

    if (state.items.length === 0) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.dataset.action = 'add';
      button.textContent = 'Add item';
      cell.append(button);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.dataset.action = 'clear-filters';
      button.textContent = 'Clear filters';
      cell.append(button);
    }

    row.append(cell);
    tbody.append(row);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of visible) {
    const row = document.createElement('tr');
    row.dataset.id = item.id;

    row.append(cellFor(item.name, 'name-cell'));
    row.append(cellFor(item.category, 'category-cell'));
    row.append(cellFor(item.location, 'location-cell'));

    const quantity = document.createElement('td');
    quantity.className = 'quantity-cell';
    quantity.textContent = String(item.quantity);
    row.append(quantity);

    const actions = document.createElement('td');
    actions.className = 'actions-cell';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button small secondary';
    edit.dataset.action = 'edit';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${item.name}`);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button small danger';
    remove.dataset.action = 'delete';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${item.name}`);

    actions.append(edit, remove);
    row.append(actions);
    fragment.append(row);
  }

  tbody.append(fragment);
}

function cellFor(text, className) {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

function getVisibleItems() {
  const query = elements.search.value.trim().toLowerCase();
  const category = elements['category-filter'].value;
  const field = elements['sort-field'].value;
  const direction = elements['sort-direction'].value === 'desc' ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const filtered = state.items.filter((item) => {
    if (category && item.category !== category) return false;
    if (!query) return true;
    return (
      item.name.toLowerCase().includes(query) ||
      item.category.toLowerCase().includes(query) ||
      item.location.toLowerCase().includes(query)
    );
  });

  return filtered.slice().sort((a, b) => {
    let comparison;
    if (field === 'quantity') {
      comparison = a.quantity - b.quantity;
    } else {
      comparison = collator.compare(a[field], b[field]);
    }
    if (comparison === 0) {
      comparison = collator.compare(a.name, b.name);
    }
    if (comparison === 0) {
      comparison = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return comparison * direction;
  });
}

function updateControls() {
  const blocked = Boolean(state.blockedReason);
  elements['add-button'].disabled = blocked;
  elements['export-button'].disabled = blocked;
  elements.search.disabled = blocked;
  elements['category-filter'].disabled = blocked;
  elements['sort-field'].disabled = blocked;
  elements['sort-direction'].disabled = blocked;
}

function handleTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const action = button.dataset.action;
  if (action === 'add') {
    if (!state.blockedReason) openItemDialog();
    return;
  }
  if (action === 'clear-filters') {
    elements.search.value = '';
    elements['category-filter'].value = '';
    renderRowsAndCounts();
    elements.search.focus();
    return;
  }

  const row = button.closest('tr');
  const id = row && row.dataset.id;
  if (!id) return;

  if (action === 'edit') {
    openItemDialog(id);
  } else if (action === 'delete') {
    deleteItem(id);
  }
}

function openItemDialog(id) {
  const item = id ? state.items.find((entry) => entry.id === id) : null;
  if (id && !item) return;

  elements['item-form'].reset();
  elements['form-error'].hidden = true;
  elements['item-id'].value = item ? item.id : '';
  elements['item-dialog-title'].textContent = item ? 'Edit item' : 'Add item';
  elements['item-submit'].textContent = item ? 'Save changes' : 'Save item';
  elements['item-name'].value = item ? item.name : '';
  elements['item-category'].value = item ? item.category : '';
  elements['item-location'].value = item ? item.location : '';
  elements['item-quantity'].value = item ? String(item.quantity) : '0';

  openDialog(elements['item-dialog']);
  window.setTimeout(() => elements['item-name'].focus(), 0);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function showFormError(message) {
  elements['form-error'].textContent = message;
  elements['form-error'].hidden = false;
}

/* --------------------------------- Notices -------------------------------- */

function showNotice(type, message, options = {}) {
  const { key, dismissible = false, actions = [] } = options;
  if (key) {
    elements.notices.querySelectorAll(`[data-notice-key="${cssEscape(key)}"]`).forEach((node) => node.remove());
  }

  const notice = document.createElement('div');
  notice.className = `notice notice-${type}`;
  if (key) notice.dataset.noticeKey = key;
  if (type === 'error') notice.setAttribute('role', 'alert');

  const text = document.createElement('p');
  text.className = 'notice-text';
  text.textContent = message;
  notice.append(text);

  if (actions.length > 0 || dismissible) {
    const controls = document.createElement('div');
    controls.className = 'notice-actions';

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button small secondary';
      button.textContent = action.label;
      button.addEventListener('click', action.handler);
      controls.append(button);
    }

    if (dismissible) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'button small ghost';
      close.textContent = 'Dismiss';
      close.addEventListener('click', () => notice.remove());
      controls.append(close);
    }

    notice.append(controls);
  }

  elements.notices.append(notice);
}

function clearNotice(key) {
  elements.notices.querySelectorAll(`[data-notice-key="${cssEscape(key)}"]`).forEach((node) => node.remove());
}

function announce(message) {
  elements['results-summary'].textContent = message;
}

/* --------------------------------- Helpers -------------------------------- */

function inventoriesEqual(a, b) {
  if (a.length !== b.length) return false;
  const normalize = (items) =>
    items
      .map((item) => ({ id: item.id, name: item.name, category: item.category, location: item.location, quantity: item.quantity }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countLabel(count) {
  return pluralize(count, 'item');
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch (error) {
    return '';
  }
}

function timestampForFilename() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
