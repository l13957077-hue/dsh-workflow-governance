#!/usr/bin/env python
"""Validate the Workflow preset the way a real YAML loader would.

Why this exists: `test/bundle.test.mjs` pins the preset's structure with **string
assertions** (regex over the raw text), so it cannot catch a YAML-level defect --
and a defect here is not cosmetic. The preset registry validates the live copy, and
a preset that fails to load shows「加载失败」on **every** card in the selector.

So this parses the file and checks the shape a directory preset actually needs.

Needs PyYAML. The throwaway venv used during development was removed to keep the workspace
clean, so recreate it only when you want to re-run this:

    pyenv_create .yamlcheck        # or:  python -m venv .yamlcheck
    pyenv_install pyyaml           # or:  .yamlcheck\Scripts\pip install pyyaml
    .yamlcheck\Scripts\python.exe docs\workflow-mode\verify_preset.py
"""
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML is not installed in this interpreter")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
PRESET_DIR = ROOT / "local-plugins" / "dsh-workflow-governance" / "presets" / "workflow"

FAILURES = []


def check(cond, msg):
    print(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILURES.append(msg)


print("=== preset.yml ===")
meta = yaml.safe_load((PRESET_DIR / "preset.yml").read_text(encoding="utf-8"))
check(isinstance(meta, dict), "parses to a mapping")
if isinstance(meta, dict):
    for key in ("name", "description", "order"):
        value = meta.get(key)
        check(value is not None and str(value).strip() != "", f"has a non-empty `{key}`")

print("=== agent.cordis.yml ===")
comp = yaml.safe_load((PRESET_DIR / "agent.cordis.yml").read_text(encoding="utf-8"))
check(isinstance(comp, list), "parses to a LIST of loader rows (a directory preset is a row array)")
check(isinstance(comp, list) and len(comp) >= 10, f"row count = {len(comp) if isinstance(comp, list) else 'n/a'} (>= 10)")

if isinstance(comp, list):
    rows = [r for r in comp if isinstance(r, dict)]
    check(len(rows) == len(comp), "every row is a mapping")

    ids = [r.get("id") for r in rows]
    check(len(set(ids)) == len(ids), f"row ids are unique ({len(ids)} rows)")
    check(all(isinstance(i, str) and i.strip() != "" for i in ids), "every row has a non-empty id")

    for r in rows:
        check(isinstance(r.get("name"), str) and r["name"].strip() != "", f"row `{r.get('id')}` has a name")

    names = [r.get("name") for r in rows]
    allowed = all(
        isinstance(n, str) and (n.startswith("@deepseek-ai/") or n == "cordis:group" or n == "dsh-workflow-governance")
        for n in names
    )
    check(allowed, "every name is an official package, `cordis:group`, or this package")

    last = rows[-1]
    check(last.get("id") == "workflow-governance", "the governance row is LAST")
    check(last.get("name") == "dsh-workflow-governance", "the governance row names this package")
    check("disabled" not in last, "the governance row is not disabled (a `disabled:` in a preset breaks every card)")

    for r in rows:
        if r.get("name") == "cordis:group":
            inner = r.get("config")
            check(isinstance(inner, list) and len(inner) > 0, f"group `{r.get('id')}` carries its inner rows")

    # No `!!js` / `disabled:` anywhere in the composition: the official *patch* uses
    # `!!js`, but a *preset* composition is validated differently and copying that
    # pattern in has broken every preset on this machine before.
    raw = (PRESET_DIR / "agent.cordis.yml").read_text(encoding="utf-8")
    code = "\n".join(line for line in raw.split("\n") if not line.lstrip().startswith("#"))
    check("!!js" not in code, "no `!!js` expression in the composition")
    check("disabled:" not in code, "no `disabled:` key in the composition")

    persona = next((r for r in rows if r.get("id") == "persona"), None)
    check(persona is not None, "a `persona` row exists")
    if persona:
        cfg = persona.get("config") or {}
        text = cfg.get("prefix") or cfg.get("text")
        check(isinstance(text, str), "persona text is a string")
        if isinstance(text, str):
            check(len(text) > 1000, f"persona text is substantial ({len(text)} chars)")
            for needle in ("contract_workflow", "when", "find", "observed", "gate_request", "inferred"):
                check(needle in text, f"persona teaches `{needle}`")
            check(("不绕过契约" in text) or ("不要试图绕过" in text), "persona forbids bypassing a contract")
            for needle in ("persona", "toolFilter", "agentOptions"):
                check(needle in text, f"persona documents the per-node `{needle}` field")
            for marker in ("工作契约", "实现边界对照", "机制强制", "未实现"):
                check(marker in text, f"persona carries the honesty section `{marker}`")

print()
if FAILURES:
    print(f"RESULT: {len(FAILURES)} check(s) FAILED")
    sys.exit(1)
print("RESULT: ALL CHECKS PASSED")
