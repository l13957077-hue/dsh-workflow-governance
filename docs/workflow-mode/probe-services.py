"""Enumerate the cordis service names this DSH build actually registers.

Answers from the shipped code, not from memory:
  * every service name registered by an @deepseek-ai/* package, and by whom
  * each plugin's declared `inject` list (what the composition must provide)
  * whether a required name (e.g. workflowEngine) is present -> exit-code gate
  * the installed @deepseek-ai/* version map (--installed-versions)

This exists because "does the host expose ctx.workflows?" was answered wrongly
once by guessing: the real registration is `super(ctx, 'workflowEngine')`. The
probe makes that question re-answerable after every host upgrade.

Usage:
  python probe-services.py
  python probe-services.py --require workflowEngine --require subagents
  python probe-services.py --installed-versions
  python probe-services.py --asar <path> --out <dir>

Exit: 0 = every --require name is present (or none requested)
      1 = a required name is missing
      2 = the script could not read the asar
"""
import argparse
import json
import os
import re
import struct
import sys

DEFAULT_ASAR = os.environ.get("DSH_ASAR") or r"<DSH install dir>\resources\app.asar"
# next to this script, so probe-services.json sits where probe-plugin-compat.py looks for it
DEFAULT_OUT = os.path.dirname(os.path.abspath(__file__))

# cordis registers a service by passing its name to the Service base constructor.
# A bare `super(x, 'NAME')` also appears in Error subclasses bundling an error
# code, so the super call is only trusted inside a class that extends *Service.
RE_SUPER = re.compile(r"super\(\s*[A-Za-z_$][\w$]*\s*,\s*['\"]([A-Za-z_][\w.\-]*)['\"]")
# ...or by providing it directly on the context.
RE_PROVIDE = re.compile(r"\.provide\(\s*['\"]([A-Za-z_][\w.\-]*)['\"]")
RE_INJECT = re.compile(r"export\s+const\s+inject\s*=\s*\[([^\]]*)\]")
# the other declaration form: a static class field
RE_STATIC_INJECT = re.compile(r"static\s+inject\s*=\s*\[([^\]]*)\]")
# bundles alias the base class (`extends _classSuper`), so resolve which
# identifiers ultimately hold a *Service before trusting a class declaration
RE_SERVICE_ALIAS = re.compile(r"([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*Service)\b")
RE_NAME_CONST = re.compile(r"export\s+const\s+name\s*=\s*['\"]([^'\"]+)['\"]")
# `class Foo extends Service {` and the bundler form `var Foo = class extends Service {`
RE_CLASS = re.compile(r"class(?:\s+([A-Za-z_$][\w$]*))?\s+extends\s+([A-Za-z_$][\w$.]*)")
RE_ASSIGNED = re.compile(r"([A-Za-z_$][\w$]*)\s*=\s*$")


def open_asar(path):
    f = open(path, "rb")
    _magic, payload, jl, _ = struct.unpack("<IIII", f.read(16))
    header = json.loads(f.read(jl).decode("utf-8"))
    return f, header, 8 + payload


def walk(node, prefix=""):
    for name, child in (node.get("files") or {}).items():
        if "files" in child:
            yield from walk(child, prefix + "/" + name)
        else:
            yield prefix + "/" + name, child


def explain(ai, read, name, window=170, limit=14):
    """Show how a service name is actually registered, so the matcher can be corrected."""
    needle = "'%s'" % name
    dbl = '"%s"' % name
    print("== explain %s ==" % name)
    hits = 0
    for pkg, node in sorted(ai.items()):
        for rel, nd in walk(node):
            if not rel.endswith((".js", ".mjs", ".cjs")):
                continue
            size = int(nd.get("size", 0))
            if size == 0 or size > 4_000_000:
                continue
            text = read(nd)
            pos = text.find(needle)
            if pos < 0:
                pos = text.find(dbl)
            if pos < 0:
                continue
            start = max(0, pos - window)
            print("-- [%s%s]" % (pkg, rel))
            print("   ...%s..." % text[start:pos + window].replace("\n", " "))
            for cm in RE_CLASS.finditer(text):
                print("   class: %s extends %s" % (cm.group(1) or "(anon)", cm.group(2)))
            hits += 1
            if hits >= limit:
                return
    if hits == 0:
        print("   (the literal never appears; it may be composed at runtime)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--asar", default=DEFAULT_ASAR)
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--require", action="append", default=[])
    ap.add_argument("--installed-versions", action="store_true")
    ap.add_argument("--explain")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.asar):
        print("asar not found: %s" % args.asar, file=sys.stderr)
        print("Pass --asar <path to app.asar> for this installation.", file=sys.stderr)
        return 2

    f, header, data_base = open_asar(args.asar)

    def read(node):
        if "offset" not in node:
            return ""
        f.seek(data_base + int(node["offset"]))
        return f.read(int(node["size"])).decode("utf-8", "replace")

    ai = header.get("files", {}).get("node_modules", {}).get("files", {}).get("@deepseek-ai", {}).get("files", {})

    if args.explain:
        explain(ai, read, args.explain)
        return 0

    versions = {}
    services = {}      # service name -> set("pkg/relpath")
    injects = {}       # pkg -> sorted list of injected service names
    plugin_names = {}  # pkg -> declared cordis plugin name

    for pkg, node in sorted(ai.items()):
        pj = (node.get("files") or {}).get("package.json")
        if pj is not None:
            try:
                versions[pkg] = json.loads(read(pj)).get("version", "?")
            except Exception:
                versions[pkg] = "?"
        for rel, nd in walk(node):
            if not rel.endswith((".js", ".mjs", ".cjs")):
                continue
            size = int(nd.get("size", 0))
            if size == 0 or size > 4_000_000:
                continue
            text = read(nd)
            where = "%s%s" % (pkg, rel)
            aliases = set(m.group(1) for m in RE_SERVICE_ALIAS.finditer(text))
            # Only trust `super(ctx, 'name')` inside a class whose base is (or
            # ultimately resolves to) a *Service: a bare super() also appears in
            # Error subclasses bundling an error code.
            classes = list(RE_CLASS.finditer(text))
            for i, cm in enumerate(classes):
                cls_base = cm.group(2)
                if not (cls_base.endswith("Service") or cls_base in aliases):
                    continue
                start = cm.start()
                end = classes[i + 1].start() if i + 1 < len(classes) else len(text)
                cls = cm.group(1)
                if cls is None:
                    prefix = text[max(0, start - 60):start]
                    assigned = RE_ASSIGNED.search(prefix)
                    cls = assigned.group(1) if assigned else "anonymous"
                for m in RE_SUPER.finditer(text[start:end]):
                    services.setdefault(m.group(1), set()).add("%s#%s" % (where, cls))
            for m in RE_PROVIDE.finditer(text):
                services.setdefault(m.group(1), set()).add(where)
            for m in list(RE_INJECT.finditer(text)) + list(RE_STATIC_INJECT.finditer(text)):
                names = re.findall(r"['\"]([^'\"]+)['\"]", m.group(1))
                if names:
                    injects.setdefault(pkg, set()).update(names)
            for m in RE_NAME_CONST.finditer(text):
                plugin_names.setdefault(pkg, m.group(1))

    if args.installed_versions:
        print(json.dumps(versions, indent=2, sort_keys=True))
        return 0

    report = {
        "asar": args.asar,
        "packageCount": len(versions),
        "serviceCount": len(services),
        "services": {k: sorted(v) for k, v in sorted(services.items())},
        "injects": {k: sorted(v) for k, v in sorted(injects.items())},
        "pluginNames": plugin_names,
        "versions": versions,
    }

    out_json = os.path.join(args.out, "probe-services.json")
    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2, sort_keys=True, ensure_ascii=False)

    lines = []
    lines.append("== installed @deepseek-ai/* packages: %d ==" % len(versions))
    lines.append("== registered cordis service names: %d ==" % len(services))
    width = max([len(s) for s in services] or [1]) + 2
    col = 3
    names = sorted(services)
    for i in range(0, len(names), col):
        lines.append("  " + "".join(n.ljust(width) for n in names[i:i + col]).rstrip())
    lines.append("")
    lines.append("== registrants for workflow-related names ==")
    for wanted in ("workflowEngine", "workflows", "subagents", "jobs", "invariants", "events"):
        who = services.get(wanted)
        if who:
            lines.append("  %-16s YES  <- %s" % (wanted, ", ".join(sorted(who))[:150]))
        else:
            lines.append("  %-16s no" % wanted)
    lines.append("")
    lines.append("== plugins with a declared inject list ==")
    for pkg in sorted(injects):
        lines.append("  %-46s inject=%s" % (pkg, ", ".join(sorted(injects[pkg]))))
    lines.append("")
    lines.append("== workflow-family packages ==")
    for pkg in sorted(versions):
        if "workflow" in pkg:
            lines.append("  %-30s %-14s plugin=%s" % (pkg, versions[pkg], plugin_names.get(pkg, "-")))

    out_txt = os.path.join(args.out, "probe-services.txt")
    with open(out_txt, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    if not args.quiet:
        print("\n".join(lines))
        print("")
        print("report -> %s" % out_txt)
        print("json   -> %s" % out_json)

    missing = [n for n in args.require if n not in services]
    if missing:
        print("")
        print("REQUIRED SERVICE MISSING: %s" % ", ".join(missing))
        print("This build does not register it. Do NOT write against it.")
        return 1
    if args.require:
        print("")
        print("REQUIRED SERVICES PRESENT: %s" % ", ".join(args.require))
    return 0


if __name__ == "__main__":
    sys.exit(main())
