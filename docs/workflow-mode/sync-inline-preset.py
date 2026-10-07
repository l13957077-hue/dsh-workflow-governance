#!/usr/bin/env python
"""Sync the「Workflow 工作模式」preset into BOTH places it lives.

README (`Two deployment facts`, and the shell section): a directory preset lives in TWO
places --

  (1) <DSH_HOME>/.agent-presets/workflow/        the DIRECTORY form, scanned by the registry
  (2) <DSH_HOME>/profiles/web/cordis.patch.yml   the INLINE form, inside `preset-workflow`

-- and the second is the one the harness ACTUALLY mounts. On 2026-10-07 only (1) was updated,
so the running preset kept its old text: that is the whole reason a restart changed nothing.

WHAT THIS TOUCHES
-----------------
Exactly one region of the patch: the rows under the `plugins:` key of the `preset-workflow`
container. Everything else in that ~1380-line file -- all five UltraMath containers, the skin
rows, the disables -- is left byte-for-byte alone. The container header (id/name/description/
order) is also left alone.

WHY THAT IS SAFE
----------------
The replacement is a pure INDENTATION SHIFT of `presets/workflow/agent.cordis.yml`, which
`verify_preset.py` already parses and validates. Shifting every non-empty row by a constant
cannot change the YAML's block structure. The script additionally re-parses the whole patch
with PyYAML and restores the backup if that parse fails.

Indentations are DETECTED, never assumed: the host re-indents the patch across restarts
(observed 2026-10-07: the container's `config:` children moved 10 -> 8 spaces).

USAGE
-----
    python docs/workflow-mode/sync-inline-preset.py --dry-run     # show the plan
    python docs/workflow-mode/sync-inline-preset.py               # apply
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKSPACE = HERE.parents[1]
SRC = WORKSPACE / "local-plugins" / "dsh-workflow-governance" / "presets" / "workflow" / "agent.cordis.yml"

DSH_HOME = Path.home() / "AppData" / "Roaming" / "dsh-desktop" / "harness"
PATCH = DSH_HOME / "profiles" / "web" / "cordis.patch.yml"

CONTAINER_ID = "preset-workflow"


def find_block(lines: list[str]) -> tuple[int, int, int]:
    """Return (start, end, row_indent) for the rows under the container's `plugins:` key."""
    container_at = None
    for i, line in enumerate(lines):
        if re.match(rf"^\s*- id: {re.escape(CONTAINER_ID)}\s*$", line):
            container_at = i
            break
    if container_at is None:
        raise SystemExit(f"container `- id: {CONTAINER_ID}` not found in {PATCH}")

    plugins_at = None
    plugins_indent = None
    for i in range(container_at, len(lines)):
        m = re.match(r"^(\s*)plugins:\s*$", lines[i])
        if m:
            plugins_at = i
            plugins_indent = len(m.group(1))
            break
    if plugins_at is None or plugins_indent is None:
        raise SystemExit(f"`plugins:` key not found under {CONTAINER_ID}")

    # The rows sit one level below `plugins:`. Derive from the first non-empty row after it.
    row_indent = plugins_indent + 2
    end = len(lines)
    for i in range(plugins_at + 1, len(lines)):
        line = lines[i]
        if line.strip() == "":
            continue
        if not line.startswith(" "):          # a top-level row/comment ends the block
            end = i
            break
    return plugins_at + 1, end, row_indent


def build_rows(src_lines: list[str], row_indent: int) -> list[str]:
    out = []
    for line in src_lines:
        if line.strip() == "":
            out.append("")                    # keep blank lines truly blank
        else:
            out.append(" " * row_indent + line)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not PATCH.exists():
        raise SystemExit(f"patch not found: {PATCH}")
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")

    patch_text = PATCH.read_text(encoding="utf-8")
    patch_lines = patch_text.split("\n")
    src_lines = SRC.read_text(encoding="utf-8").split("\n")
    if src_lines and src_lines[-1] == "":
        src_lines = src_lines[:-1]            # drop the trailing empty element

    start, end, row_indent = find_block(patch_lines)
    rows = build_rows(src_lines, row_indent)
    print(f"patch            : {PATCH}  ({len(patch_lines)} lines)")
    print(f"source           : {SRC}  ({len(src_lines)} rows)")
    print(f"row indent       : {row_indent} spaces")
    print(f"replacing lines  : {start + 1}..{end}  ({end - start} lines)")
    print(f"  first old line : {patch_lines[start].strip()[:70]!r}")
    print(f"  last  old line : {patch_lines[end - 1].strip()[:70]!r}")
    print(f"  first new line : {rows[0].strip()[:70]!r}")
    print(f"  last  new line : {rows[-1].strip()[:70]!r}")

    new_lines = patch_lines[:start] + rows + patch_lines[end:]
    print(f"resulting patch  : {len(new_lines)} lines (delta {len(new_lines) - len(patch_lines):+d})")

    joined = "\n".join(new_lines)
    gov = len(re.findall(r"(?m)^\s*- id: workflow-governance\s*$", joined))
    term = len(re.findall(r"(?m)^# dsh-desktop legacy presets end\s*$", joined))
    ultramath = len(re.findall(r"(?m)^\s*- id: preset-ultramath", joined))
    print(f"checks           : workflow-governance={gov} (want 1)  terminator={term} (want 1)  preset-ultramath rows={ultramath} (want 5)")
    if gov != 1 or term != 1 or ultramath != 5:
        raise SystemExit("REFUSING: sanity checks failed; nothing written.")

    try:
        import yaml
        parsed = yaml.safe_load(joined)

        def find_container(entries):
            for e in entries:
                if not isinstance(e, dict):
                    continue
                if e.get("id") == CONTAINER_ID:
                    return e
                ins = e.get("insert")
                if isinstance(ins, list):
                    for row in ins:
                        if isinstance(row, dict) and row.get("id") == CONTAINER_ID:
                            return row
            return None

        c = find_container(parsed)
        print(f"PyYAML           : parsed OK, {len(parsed)} top-level entries")
        plugins = (c.get("config") or {}).get("plugins") if isinstance(c, dict) else None
        if not isinstance(plugins, list):
            raise SystemExit("REFUSING: parsed patch has no usable preset-workflow container.")
        names = [r.get("name") for r in plugins if isinstance(r, dict)]
        print(f"                   preset-workflow found under `insert`; plugins rows = {len(plugins)}")
        print(f"                   first row name = {names[0]!r}; governance row present = {'dsh-workflow-governance' in names}")
    except ImportError:
        print("PyYAML           : not importable -- relying on the constant-indent argument above")

    if args.dry_run:
        print("\nDRY RUN -- nothing written.")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S")
    vault = DSH_HOME / f"preset-store-backup-{stamp}"
    vault.mkdir(parents=True, exist_ok=True)
    backup = vault / "web-cordis.patch.yml"
    shutil.copy2(PATCH, backup)
    print(f"\nbacked up        : {backup}")

    PATCH.write_text(joined, encoding="utf-8")
    print(f"wrote            : {PATCH}")

    after = PATCH.read_text(encoding="utf-8")
    ok = (
        len(re.findall(r"(?m)^\s*- id: workflow-governance\s*$", after)) == 1
        and len(re.findall(r"(?m)^# dsh-desktop legacy presets end\s*$", after)) == 1
        and len(after.split("\n")) == len(new_lines)
    )
    print(f"read-back check  : governance row present = {ok}")
    if not ok:
        shutil.copy2(backup, PATCH)
        print("RESTORED from backup.")
        return 1
    print("\nOK. Restart DSH.")
    print(f"Rollback: Copy-Item -Force '{backup}' '{PATCH}'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
