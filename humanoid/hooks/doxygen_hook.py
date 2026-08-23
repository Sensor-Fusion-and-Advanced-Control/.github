import pathlib
import shutil
import subprocess

from mkdocs.plugins import event_priority


def _resolve_doxygen_binary() -> str | None:
    # First preference: respect PATH.
    path_binary = shutil.which('doxygen')
    if path_binary is not None:
        return path_binary

    # Windows fallback: winget installer often puts Doxygen here.
    windows_candidates = [
        pathlib.Path(r'C:\Program Files\doxygen\bin\doxygen.exe'),
        pathlib.Path(r'C:\Program Files\Doxygen\bin\doxygen.exe'),
        pathlib.Path(r'C:\Program Files (x86)\doxygen\bin\doxygen.exe'),
        pathlib.Path(r'C:\Program Files (x86)\Doxygen\bin\doxygen.exe'),
    ]

    for candidate in windows_candidates:
        if candidate.exists():
            return str(candidate)

    return None


@event_priority(100)
def on_pre_build(config):
    root = pathlib.Path(__file__).resolve().parents[2]
    doxyfile = root / 'Doxyfile'

    if not doxyfile.exists():
        print('[docs] Doxyfile not found. Skipping C++ API generation.')
        return

    doxygen_bin = _resolve_doxygen_binary()
    if doxygen_bin is None:
        print('[docs] Doxygen not found on PATH. Using existing C++ API files.')
        return

    print('[docs] Running Doxygen for C++ API generation...')
    subprocess.run([doxygen_bin, str(doxyfile)], check=True, cwd=root)
