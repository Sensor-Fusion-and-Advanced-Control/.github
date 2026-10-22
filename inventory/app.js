'use strict';

const SUPPORTED_VERSIONS = new Set([1, 2]);
const MAX_TEXT_LENGTH = 200;
const DEFAULT_OWNER = 'lab';
const FILENAME = 'inventory.json';

class ValidationError extends Error {}

const state = {
  items: [],
  loaded: false,
  failed: false,
};

const elements = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  bindEvents();
  render();
  await fetchCanonical();
}

function cacheElements() {
  for (const id of [
    'notices', 'total-count', 'category-count', 'visible-count',
    'search', 'category-filter', 'sort-field', 'sort-direction',
    'results-summary', 'item-body',
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  elements.search.addEventListener('input', renderRowsAndCounts);
  elements['category-filter'].addEventListener('change', renderRowsAndCounts);
  elements['sort-field'].addEventListener('change', renderRowsAndCounts);
  elements['sort-direction'].addEventListener('change', renderRowsAndCounts);
  elements['item-body'].addEventListener('click', handleTableClick);
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

function normalizeOptionalText(value, label) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${label} must be ${MAX_TEXT_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

const REQUIRED_ITEM_FIELDS = ['id', 'name', 'category', 'location', 'quantity'];
const OPTIONAL_ITEM_FIELDS = ['nameFa', 'categoryFa', 'locationFa', 'owner'];
const ITEM_FIELDS = [...REQUIRED_ITEM_FIELDS, ...OPTIONAL_ITEM_FIELDS];

function validateItem(raw, index) {
  const label = `Item ${index + 1}`;
  if (!isPlainObject(raw)) {
    throw new ValidationError(`${label} must be an object.`);
  }

  const missing = REQUIRED_ITEM_FIELDS.filter((field) => !Object.prototype.hasOwnProperty.call(raw, field));
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

  const item = {
    id: validateId(raw.id, `${label} id`),
    name: validateText(raw.name, `${label} name`),
    category: validateText(raw.category, `${label} category`),
    location: validateText(raw.location, `${label} location`),
    quantity: raw.quantity,
  };

  item.owner = Object.prototype.hasOwnProperty.call(raw, 'owner')
    ? normalizeOptionalText(raw.owner, `${label} owner`) || DEFAULT_OWNER
    : DEFAULT_OWNER;

  const optionalLabels = {
    nameFa: `${label} Persian name`,
    categoryFa: `${label} Persian category`,
    locationFa: `${label} Persian location`,
  };

  for (const [field, fieldLabel] of Object.entries(optionalLabels)) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    const text = normalizeOptionalText(raw[field], fieldLabel);
    if (text !== '') item[field] = text;
  }

  return item;
}

function validateInventory(raw) {
  if (!isPlainObject(raw)) {
    throw new ValidationError('The inventory must be a JSON object.');
  }

  const unknown = Object.keys(raw).filter((key) => key !== 'version' && key !== 'items');
  if (unknown.length > 0) {
    throw new ValidationError(`The inventory has unknown field(s): ${unknown.join(', ')}.`);
  }

  if (!SUPPORTED_VERSIONS.has(raw.version)) {
    throw new ValidationError('The inventory version is not supported. This page reads versions 1 and 2.');
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

/* --------------------------------- Loading -------------------------------- */

async function fetchCanonical() {
  try {
    const response = await fetch(`${FILENAME}?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    state.items = validateInventory(data);
    state.loaded = true;
    state.failed = false;
  } catch (error) {
    state.items = [];
    state.loaded = false;
    state.failed = true;
    showNotice('error', fetchFailureMessage(error));
  }
  render();
}

function fetchFailureMessage(error) {
  const detail = error instanceof Error ? error.message : String(error);

  if (error instanceof ValidationError) {
    return `inventory.json was found but rejected: ${detail} Fix the file in the repository.`;
  }

  if (window.location.protocol === 'file:') {
    return `inventory.json could not be read because the page was opened directly from disk (file://). Browsers block that kind of local file access. Serve the folder with a local web server or use the published site. (${detail})`;
  }

  return `inventory.json could not be loaded (${detail}). Check that the file exists next to index.html and that it is valid.`;
}

/* --------------------------------- Rendering ------------------------------ */

function render() {
  renderCategoryOptions();
  renderRowsAndCounts();
}

function renderCategoryOptions() {
  const categories = [...new Set(state.items.map((item) => item.category))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  );

  const persianByCategory = new Map();
  for (const item of state.items) {
    if (!persianByCategory.get(item.category) && item.categoryFa) {
      persianByCategory.set(item.category, item.categoryFa);
    }
  }

  const previous = elements['category-filter'].value;
  const filter = elements['category-filter'];
  filter.replaceChildren(new Option('All categories', ''));
  for (const category of categories) {
    const persian = persianByCategory.get(category);
    filter.append(new Option(persian ? `${category} — ${persian}` : category, category));
  }
  filter.value = categories.includes(previous) ? previous : '';
}

function renderRowsAndCounts() {
  const visible = getVisibleItems();
  const categoryCount = new Set(state.items.map((item) => item.category)).size;

  elements['total-count'].textContent = String(state.items.length);
  elements['category-count'].textContent = String(categoryCount);
  elements['visible-count'].textContent = String(visible.length);

  const activeFilters = elements.search.value.trim() !== '' || elements['category-filter'].value !== '';
  let summary;
  if (state.failed) {
    summary = 'The inventory is not loaded.';
  } else if (!state.loaded) {
    summary = 'Loading inventory…';
  } else if (state.items.length === 0) {
    summary = 'No items in the inventory.';
  } else if (activeFilters) {
    summary = `Showing ${visible.length} of ${pluralize(state.items.length, 'item')} after search and filters.`;
  } else {
    summary = `Showing all ${pluralize(state.items.length, 'item')}.`;
  }
  elements['results-summary'].textContent = summary;

  const tbody = elements['item-body'];
  tbody.replaceChildren();

  if (visible.length === 0) {
    tbody.append(emptyRow());
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of visible) {
    const row = document.createElement('tr');
    row.append(bilingualCell(item.name, item.nameFa, 'name-cell'));

    const owner = document.createElement('td');
    owner.className = 'owner-cell';
    owner.textContent = item.owner;
    row.append(owner);

    row.append(bilingualCell(item.category, item.categoryFa, 'category-cell'));
    row.append(bilingualCell(item.location, item.locationFa, 'location-cell'));

    const quantity = document.createElement('td');
    quantity.className = 'quantity-cell';
    quantity.textContent = String(item.quantity);
    row.append(quantity);

    fragment.append(row);
  }

  tbody.append(fragment);
}

function emptyRow() {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 5;
  cell.className = 'empty-cell';

  const message = document.createElement('p');
  message.className = 'empty-title';

  const hint = document.createElement('p');
  hint.className = 'muted';

  const hasItems = state.items.length > 0;

  if (!state.loaded) {
    message.textContent = state.failed ? 'Inventory not loaded.' : 'Loading inventory…';
    hint.textContent = state.failed
      ? 'See the notice above for the reason inventory.json could not be loaded.'
      : 'Reading inventory.json.';
    cell.append(message, hint);
  } else if (hasItems) {
    message.textContent = 'No items match your search or filters.';
    hint.textContent = 'Try a different search or clear the filters.';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.dataset.action = 'clear-filters';
    button.textContent = 'Clear filters';
    cell.append(message, hint, button);
  } else {
    message.textContent = 'No items yet.';
    hint.textContent = 'The canonical inventory.json is empty.';
    cell.append(message, hint);
  }

  row.append(cell);
  return row;
}

function bilingualCell(primary, secondary, className) {
  const cell = document.createElement('td');
  cell.className = className;

  const main = document.createElement('span');
  main.className = 'value-primary';
  main.textContent = primary;
  cell.append(main);

  if (secondary) {
    const alt = document.createElement('span');
    alt.className = 'value-secondary';
    alt.lang = 'fa';
    alt.dir = 'rtl';
    alt.textContent = secondary;
    cell.append(alt);
  }

  return cell;
}

function getVisibleItems() {
  const query = normalizeForSearch(elements.search.value);
  const category = elements['category-filter'].value;
  const field = elements['sort-field'].value;
  const direction = elements['sort-direction'].value === 'desc' ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const filtered = state.items.filter((item) => {
    if (category && item.category !== category) return false;
    if (!query) return true;
    const haystack = normalizeForSearch([
      item.name,
      item.nameFa,
      item.owner,
      item.category,
      item.categoryFa,
      item.location,
      item.locationFa,
    ].filter(Boolean).join(' '));
    return haystack.includes(query);
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

function handleTableClick(event) {
  const button = event.target.closest('button[data-action="clear-filters"]');
  if (!button) return;
  elements.search.value = '';
  elements['category-filter'].value = '';
  renderRowsAndCounts();
  elements.search.focus();
}

/* --------------------------------- Notices -------------------------------- */

function showNotice(type, message) {
  const notice = document.createElement('div');
  notice.className = `notice notice-${type}`;
  if (type === 'error') notice.setAttribute('role', 'alert');

  const text = document.createElement('p');
  text.className = 'notice-text';
  text.textContent = message;
  notice.append(text);

  elements.notices.append(notice);
}

/* --------------------------------- Helpers -------------------------------- */

function normalizeForSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[\u064A\u0649]/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/\u0629/g, '\u0647')
    .replace(/[\u200C\u0640]/g, '')
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/\s+/g, ' ')
    .trim();
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
