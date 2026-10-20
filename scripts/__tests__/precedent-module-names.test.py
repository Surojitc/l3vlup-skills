"""
No module of the precedent collector assigns the same top-level name twice.

Python lets a later `NAME = ...` silently replace an earlier one, and every
function in the module then reads the later value. On 20 October 2026 two
pull requests, each correct on its own, both defined `_INSTRUMENT` in parse.py:
the share-count reader's pattern (options, warrants, awards) replaced the
premium reader's (a capped call's cap, a conversion or exercise price), and the
premium rule stopped working on main without any test of its own module
failing to import. This test reads each module's syntax tree, so a second
definition fails here, by name and line, before it can shadow the first.
"""
import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "precedent_transactions"
failed = 0
checked = 0
for path in sorted(ROOT.glob("*.py")):
    tree = ast.parse(path.read_text(), filename=str(path))
    seen: dict[str, int] = {}
    before = failed
    for node in tree.body:
        targets = []
        if isinstance(node, ast.Assign):
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            targets = [node.target.id]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            targets = [node.name]
        for name in targets:
            checked += 1
            if name in seen:
                failed += 1
                print(f"FAIL  {path.name}: {name} defined at line {seen[name]} and again at line {node.lineno}")
            else:
                seen[name] = node.lineno
    if failed == before:
        print(f"PASS  {path.name}: no top-level name defined twice")
print(f"\n{checked} top-level names checked, {failed} defined twice")
sys.exit(1 if failed else 0)
