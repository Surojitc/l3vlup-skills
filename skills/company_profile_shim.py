"""Import shim so tests can import the hyphenated skill directory."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "_company_profile", Path(__file__).parent / "company-profile" / "build.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]
build = _mod.build
