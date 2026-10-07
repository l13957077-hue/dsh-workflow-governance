"""Static compatibility check for a candidate third-party DSH plugin.

Answers, from the candidate's own shipped files plus this build's real inventory:
  * does it depend on @deepseek-ai/* packages, at versions this build has?
  * does its `inject` list name services this build actually registers?
  * does it REGISTER a service name that this build already registers?
    (important: the official seam allows only one workflow engine per context --
     loading a second throws, so a candidate registering `workflowEngine` would
     conflict with the official dsh-workflow)
  * what does its `dsh.client.inject` list require?

It is STATIC analysis. It can prove a blocker; it can never prove runtime
compatibility, and it says so in the verdict.

Usage:
  python probe-plugin-compat.py --plugin <unpacked dir> [--services-json <probe-services.json>]
  python probe-plugin-compat.py --plugin ./package --name "dsh-workflow@0.1.0"

Get the candidate first (on a networked host):
  npm pack dsh-workflow@0.1.0 && tar -xzf dsh-workflow-0.1.0.tgz

Exit: 0 = no static blocker, 1 = at least one static blocker, 2 = usage error
"""
import argparse
import json
import os
import re
import sys

# --- the same registration matchers used by probe-services.py -----------------
RE_SUPER = re.compile(r"super\(\s*[A-Za-z_$][\w$]*\s*,\s*['\"]([A-Za-z_][\w.\-]*)['\"]")
RE_PROVIDE = re.compile(r"\.provide\(\s*['\"]([A-Za-z_][\w.\-]*)['\"]")
RE_INJECT = re.compile(r"export\s+const\s+inject\s*=\s*\[([^\]]*)\]")
RE_STATIC_INJECT = re.compile(r"static\s+inject\s*=\s*\[([^\]]*)\]")
RE_SERVICE_ALIAS = re.compile(r"([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*Service)\b")
RE_CLASS = re.compile(r"class(?:\s+([A-Za-z_$][\w$]*))?\s+extends\s+([A-Za-z_$][\w$.]*)")
RE_ASSIGNED = re.compile(r"([A-Za-z_$][\w$]*)\s*=\s*$")
RE_NAME_CONST = re.compile(r"export\s+const\s+name\s*=\s*['\"]([^'\"]+)['\"]")
RE_QUOTED = re.compile(r"['\"]([^'\"]+)['\"]")


def scan(root, max_bytes=4_000_000):
    services, injects, names, manifest = {}, {}, {}, None
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git")]
        for fn in filenames:
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, root)
            if fn == "package.json" and manifest is None:
                try:
                    with open(path, encoding="utf-8") as fh:
                        manifest = json.load(fh)
                except Exception:
                    pass
                continue
            if not fn.endswith((".js", ".mjs", ".cjs")):
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except Exception:
                continue
            if len(text) > max_bytes:
                continue
            scanned += 1
            aliases = set(m.group(1) for m in RE_SERVICE_ALIAS.finditer(text))
            classes = list(RE_CLASS.finditer(text))
            for i, cm in enumerate(classes):
                cls_base = cm.group(2)
                if not (cls_base.endswith("Service") or cls_base in aliases):
                    continue
                start = cm.start()
                end = classes[i + 1].start() if i + 1 < len(classes) else len(text)
                cls = cm.group(1)
                if cls is None:
                    assigned = RE_ASSIGNED.search(text[max(0, start - 60):start])
                    cls = assigned.group(1) if assigned else "anonymous"
                for m in RE_SUPER.finditer(text[start:end]):
                    services.setdefault(m.group(1), []).append("%s#%s" % (rel, cls))
            for m in RE_PROVIDE.finditer(text):
                services.setdefault(m.group(1), []).append(rel)
            for m in list(RE_INJECT.finditer(text)) + list(RE_STATIC_INJECT.finditer(text)):
                got = RE_QUOTED.findall(m.group(1))
                if got:
                    injects.setdefault("inject", set()).update(got)
            for m in RE_NAME_CONST.finditer(text):
                names.setdefault("name", m.group(1))
    return services, injects.get("inject", set()), names.get("name"), manifest, scanned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plugin", required=True)
    ap.add_argument("--services-json", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-services.json"))
    ap.add_argument("--name")
    args = ap.parse_args()

    if not os.path.isdir(args.plugin):
        print("not a directory: %s" % args.plugin, file=sys.stderr)
        print("Unpack the tarball first: npm pack <spec> && tar -xzf <file>.tgz", file=sys.stderr)
        return 2

    if not os.path.exists(args.services_json):
        print("inventory not found: %s" % args.services_json, file=sys.stderr)
        print("Run probe-services.py first (it writes probe-services.json).", file=sys.stderr)
        return 2

    with open(args.services_json, encoding="utf-8") as fh:
        inv = json.load(fh)
    installed_services = set(inv.get("services", {}))
    installed_versions = inv.get("versions", {})

    services, injects, declared_name, manifest, scanned = scan(args.plugin)
    manifest = manifest or {}
    label = args.name or manifest.get("name") or os.path.basename(os.path.abspath(args.plugin))

    blockers = []
    risks = []
    fixes = []

    print("== candidate: %s ==" % label)
    print("   version          : %s" % manifest.get("version", "?"))
    print("   cordis name      : %s" % (declared_name or "(not declared)"))
    print("   source files read: %d" % scanned)
    print("   services it registers : %s" % (", ".join(sorted(services)) or "(none)"))
    print("   services it injects   : %s" % (", ".join(sorted(injects)) or "(none)"))
    print("")

    # 1. @deepseek-ai/* dependency versions
    print("== 1. declared @deepseek-ai/* dependencies ==")
    deps = {}
    for field in ("dependencies", "peerDependencies", "devDependencies"):
        for k, v in (manifest.get(field) or {}).items():
            if k.startswith("@deepseek-ai/"):
                deps[k] = (v, field)
    if not deps:
        print("   (none declared -- no static version coupling, but also no proof of compatibility)")
    for k in sorted(deps):
        spec, field = deps[k]
        have = installed_versions.get(k.split("/", 1)[1])
        if have is None:
            print("   %-46s %-12s declared %s -> INSTALLED BUILD LACKS IT" % (k, field, spec))
            if field in ("dependencies", "peerDependencies"):
                blockers.append("missing-package:%s" % k)
        else:
            plain = spec.lstrip("^~>=< ")
            same = plain == have
            tag = "exact-match" if same else "range-or-drift"
            print("   %-46s %-12s declared %-12s installed %-12s %s" % (k, field, spec, have, tag))
            if not same:
                risks.append("version-drift:%s declared %s installed %s" % (k, spec, have))

    # 2. inject list against the real inventory
    print("")
    print("== 2. injected services present in this build? ==")
    if not injects:
        print("   (no inject list found; the plugin may resolve services at runtime)")
    for name in sorted(injects):
        mark = "OK" if name in installed_services else "MISSING"
        print("   %-34s %s" % (name, mark))
        if name not in installed_services:
            blockers.append("injects-missing-service:%s" % name)

    # 3. service-name collisions
    print("")
    print("== 3. service-name collisions ==")
    collided = sorted(set(services) & installed_services)
    if not services:
        print("   (it registers no service)")
    elif not collided:
        print("   (no collision: %s)" % ", ".join(sorted(services)))
    for name in collided:
        who = ", ".join(sorted(set(inv["services"][name])))[:110]
        print("   %-24s COLLISION with %s" % (name, who))
        risks.append("registers-existing-service:%s" % name)
        if name == "workflowEngine":
            fixes.append(
                "workflowEngine admits ONE engine per context (loading a second throws). "
                "If this plugin replaces the official engine, the composition must displace "
                "@deepseek-ai/dsh-workflow rather than add alongside it."
            )

    # 4. the web client face
    print("")
    print("== 4. dsh manifest / client face ==")
    dsh = manifest.get("dsh") or {}
    if not dsh:
        print("   (no dsh manifest)")
    client = dsh.get("client") or {}
    for name in (client.get("inject") or []):
        mark = "OK" if name in installed_services or name.startswith("@deepseek-ai/") else "MISSING"
        print("   client.inject %-42s %s" % (name, mark))
        if mark == "MISSING":
            blockers.append("client-injects-missing:%s" % name)
    if client.get("platform"):
        print("   client.platform %s" % client["platform"])
    if dsh.get("bundle"):
        print("   bundle.patch %s" % (dsh["bundle"].get("patch")))

    print("")
    if blockers:
        verdict = "STATIC-BLOCKER"
    elif risks:
        verdict = "STATIC-RISK"
    else:
        verdict = "STATIC-OK"
    print("VERDICT: %s" % verdict)
    if blockers:
        print("  blockers:")
        for b in blockers:
            print("    - %s" % b)
    if risks:
        print("  risks (not necessarily fatal):")
        for r in risks:
            print("    - %s" % r)
    for f in fixes:
        print("  note: %s" % f)
    print("")
    print("STATIC ANALYSIS ONLY. It can prove a blocker; it cannot prove runtime")
    print("compatibility. Only loading the plugin in a real DSH host settles that")
    print("(stage 2 of HOST-INSTALL-CHECKLIST.md), and the load must be reversible.")

    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
