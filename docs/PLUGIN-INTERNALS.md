# dsh-workflow-governance

Host-side governance layer for the `workflow` work mode. It fills exactly the
three gaps the plugin set leaves open, and nothing else:

| Gap | Requirement | Module |
| --- | --- | --- |
| **R7** | **edge + data contracts** (`{from,to,when}` with JSON Schema; checked before and after every spawn; failure goes back upstream) | `src/contract.js` + `src/graph-run.js` + the `contract_workflow` tool |
| D6 | periodic deadlock detection on top of the plugins' retry/resume | `src/deadlock.js` |
| D4 (increment) | semantic scoring over the existing template library | `src/matcher.js` |
| R9/R10 | dynamic capability authorization between sub-agents | `src/gate.js` |
| D5 (seam) | concrete adapter over the OFFICIAL `ctx.workflowEngine` | `src/engine-adapter.js` |
| D6 (seam) | observation → run record → graph projection + stall detection | `src/observe.js` |
| **G1** | **saved-workflow library** (R11/R12/R14/R15): filesystem store, CRUD, export/import, run history, and `find` delegating to `matcher.js` | `src/library.js` + the `contract_workflow_library` tool |
| host entry | switch gating, tool registration, stall scan, fail-soft degradation | `src/plugin.js` (host shim: `lib/index.js`) |

Signature source for the seam: `docs/workflow-mode/OFFICIAL-SEAM.md`, extracted from the
installed DSH Desktop asar (`@deepseek-ai/*` at `0.2.0-rc.2`). The tool-registration shape
and the `workflow/*` vocabulary are taken from that shipped code, not guessed.

### R7: why this layer owns the graph

The official `workflow` tool runs a model-written script whose `agent()` calls cross **no
declared contract**, and the engine owns that VM, so a contract layer cannot intercept it
from outside. This layer therefore owns the whole graph:

```
before spawning a node : every incoming edge's `when` must admit the upstream outputs,
                         otherwise the node is NOT spawned (BLOCKED_BY_CONTRACT)
after  spawning a node : the output must satisfy every outgoing edge's `when`, otherwise
                         the producer is re-run ("failure goes back upstream") up to
                         maxAttemptsPerNode, then the run stops naming that upstream node
always                 : a contract using a keyword this layer cannot enforce ($ref,
                         patternProperties, if/then/else, format, ...) is REFUSED -- never
                         silently downgraded to "no constraint"
```

An edge with no `when` is refused outright: this layer does not allow unconstrained edges.

## Install

This package is simultaneously the tested library and an installable cordis
bundle (same convention as the other local plugins in this workspace):

```powershell
dsh plugin --profile web add link:<repo>\local-plugins\dsh-workflow-governance
```

The patch is **additive only**: it inserts this one row. It never inserts or
replaces `@deepseek-ai/dsh-workflow`, because the seam admits **one engine per
context** and a second registration throws. Enabling the official workflow
packages is a separate, explicit host step (`docs/workflow-mode/STAGE2-PROBE.md`
§7a). Nothing is disabled either — this layer must not remove native capability
to install itself.

**Inert by default**: with no `config.json` every switch is off, so `apply()` logs
one line and returns. The authoritative switch list is in `src/config.js`; it is not
re-enumerated here so this line cannot drift. To opt in, place a `config.json` next to
`package.json`:

```json
{
  "switches": { "workflowMode": false, "deadlockDetector": true, "semanticMatcher": false, "capabilityGate": false, "contracts": true, "templateLibrary": true, "resultArtifacts": true },
  "deadlock": { "scanIntervalMs": 30000, "idleTimeoutMs": 60000, "escalateAfter": 3 },
  "contracts": { "maxAttemptsPerNode": 2 },
  "library": { "root": "library" }
}
```

- `deadlockDetector` subscribes the 6 `workflow/*` events and reports a silent run. It never
  cancels or disposes anything.
- `contracts` registers the `contract_workflow` tool (R7). With it off, no tool is registered.
- `templateLibrary` registers the `contract_workflow_library` tool (R11/R12/R14/R15).
- `library.root` is resolved against the plugin directory unless it is absolute, so the layer never
  invents a machine-global location. Point it at a durable path if you want the store to survive a
  plugin reinstall.

### G1: the saved-workflow library

`contract_workflow_library` takes one `action`:

| action | effect |
| --- | --- |
| `list` / `get` | read-only; `list` returns summaries only, never whole graphs |
| `find` | R12: scores the store against a task via `matcher.js` and returns `reuse` / `ask` / `create` |
| `save` | validates first — an unenforceable contract, a cycle or a dangling edge is **refused** |
| `rename` / `remove` | R15 |
| `record` | updates the success history that `find` scores with |
| `export` / `import` | JSON round-trip; an import is validated exactly like an authored definition |

`contract_workflow` also accepts `{ "name": "<saved>" }` instead of an inline graph, which is R14:
the stored graph is loaded, its contracts enforced identically, and the run updates that workflow's
history. A name that does not exist returns `NOT_FOUND` and spawns nothing.

**Fail-closed, twice over.** A saved workflow is a promise that its contracts will be enforced
later, so `save` refuses anything `validateWorkflow` rejects — including any contract keyword this
layer cannot enforce. And a corrupt `library.json` is reported as an error rather than treated as an
empty store, because overwriting it would destroy the operator's data.

**Names** are JSON keys inside one file, never filenames (`src/library.js` is deliberately a
single-file store). That is why a name may be any printable string, including CJK, while control
characters, surrounding whitespace, `.`, `..` and over-long names are refused.

An absent, unreadable or invalid `config.json` degrades to all-off — never to a
half-enabled state.

## Design rules honoured

- **No plugin internals touched.** Nothing here imports, patches, wraps or intercepts
  DSH or any plugin. It is pure library code behind an explicit call.
- **Independent namespace.** Own directory, own `package.json`, own config file path,
  own state, own resources. It registers no service, so it cannot collide with one.
- **Independent switch per feature, all default off.** The authoritative list is the
  `switches` block in `src/config.js` (seven entries); not re-enumerated here so it
  cannot drift. With a switch off the feature
  is inert: `authorize()` returns `GRANT.NATIVE` and delegates, so this layer can
  never add a denial to the native plugin path.
- **Observe-only on the seam.** The plugin subscribes to the 6 `workflow/*` events
  and reports. It never calls `start`/`cancel`/`dispose`, not even on its own runs.
  Control stays exclusive to the adapter's own-run registry, which the plugin never
  populates — so it has no path to control anything.
- **Fail-closed on the enforcement boundary.** Unknown agent, unknown capability,
  unknown request, missing reason, expired grant, already-spent grant, disabled
  switch: all deny or refuse.
- **Fail-soft on the host boundary.** A missing config, an engine without `start()`,
  a ctx without `on()`, or a composition without a timer service each degrade to a
  warning instead of throwing.
- **No duplicated capability.** Retry, resume, sub-agent isolation, persistence,
  template CRUD/rename and sandboxing are the plugins' job and are not reimplemented.

## API

```js
import { detectDeadlock, createDeadlockMonitor, explainDeadlock, STATE } from 'dsh-workflow-governance/deadlock';
import { selectTemplate } from 'dsh-workflow-governance/matcher';
import { CapabilityGate, DENY, GRANT } from 'dsh-workflow-governance/gate';
import { loadConfig, saveConfig, defaultConfig } from 'dsh-workflow-governance/config';
import { WorkflowEngineAdapter, WORKFLOW_EVENTS } from 'dsh-workflow-governance/engine-adapter';
import { createRunObserver, projectGraph, detectStall, explainStall } from 'dsh-workflow-governance/observe';
```

Official seam, used as verified (`ctx.workflowEngine`, 6 observe-only events):

```js
const adapter = new WorkflowEngineAdapter({ engine: ctx.workflowEngine, ctx });
const detach = adapter.attach();                       // subscribes all 6 events, { global: true }
const observer = createRunObserver();
adapter.onObservation((o) => observer.observe(o));      // owned runs only are ever tracked

const { runId } = adapter.start({ script, meta, parent });   // throws what start() throws
const stall = detectStall(observer.record(runId), { now, idleTimeoutMs: 60_000 });
const graph = projectGraph(observer.record(runId));     // edges are INFERRED from phase order
await adapter.settle(runId);                            // waits, then ALWAYS disposes
detach();
```

Two hard properties, both covered by tests:

- **Control is never taken from an event.** Payloads carry an identity snapshot, never a live run;
  `cancel`/`dispose` accept only ids we started. A forged payload exposing `cancel()` is refused.
- **A nominally `RUNNING` but silent agent IS the stall.** The official run has no overall elapsed-time
  deadline (`timeoutMs: null`) and the `workflow` tool blocks the parent turn until settlement, so a
  `running > 0` short-circuit would make the detector blind to its own main case.

Detector selection, because the vocabulary forces it:

| Instrument | Kind | For |
| --- | --- | --- |
| `detectDeadlock` | status-based | sources that expose `BLOCKED` (e.g. a declarative DAG plugin's graph) |
| `detectStall` | time-based | the official `workflow/*` vocabulary, which has **no `BLOCKED` state** |

Known limitation, asserted in the tests rather than assumed away: the events carry **no dependency
structure**, so `projectGraph` marks edges `inferred:phase-order`; and work that never started has no
event, therefore no node — a poisoned dependency surfaces through the record / run `stopReason`, not
through the graph.

Scoring formula (`matcher`):

```
score = base * historyFactor
base          = (labelWeight*labelJaccard + embeddingWeight*cosine) / (labelWeight + embeddingWeight)
historyFactor = historyFloor + (1 - historyFloor) * successRate   // 1 when the template has no history
```

`decision = score >= reuseThreshold ? 'reuse' : score >= askThreshold ? 'ask' : 'create'`.
Defaults: reuse `0.8`, ask `0.6`, `historyFloor` `0.5`.
The built-in embedding is a deterministic hashed bag-of-words (CJK characters +
bigrams) so there is no network or model dependency; pass `embed` to use a real
embedding provider.

Deadlock verdict is over-inclusive by design, because the only action it drives is
"suspend and hand to a human":

- literal rule: every unfinished node is `BLOCKED` and nothing is `RUNNING`;
- structural rule: nothing can start at all (no runnable node), which is what a
  dependency cycle or a poisoned dependency looks like.

`cause` then distinguishes `BLOCKED-FLAG-STALE`, `POISONED-DEPENDENCY`,
`DEPENDENCY-CYCLE`, `NOTHING-RUNNABLE`. The detector never throws on graph input —
a malformed template is reported as `issues` so one bad template cannot kill the loop.
`createDeadlockMonitor` requires `escalateAfter` consecutive stuck scans and notifies
on the rising edge only.

## Verify

```
node --test test/        # via the node test runner
node examples/smoke.mjs  # end-to-end demonstration, prints a report and "SMOKE OK"
node examples/demo.mjs   # R7 + G1 through the REAL tool path, prints "DEMO OK"
```

`examples/demo.mjs` drives the registered tools (a fake host stands in for cordis), so it shows the
tool surface a host would actually see — including the contract retry, the fail-closed refusal, the
library CRUD, `find`, a run by saved name, and the corrupt-store guard.

If the sandbox blocks the test runner's child processes (`spawn EPERM`), run each
file directly instead — it executes in-process with the same result:

```
node test/config.test.mjs
node test/deadlock.test.mjs
node test/gate.test.mjs
node test/matcher.test.mjs
node test/adapter.test.mjs
node test/observe.test.mjs
node test/plugin.test.mjs
node test/contract.test.mjs
node test/graph-run.test.mjs
node test/library.test.mjs
node test/bundle.test.mjs
```

Measured: **327 tests pass, 0 fail, every file exits 0**
(adapter 21, artifacts 12, bundle 7, config 13, contract 23, deadlock 21, diagram 24, gate 19, graph-run 15, library 24, matcher 17, observe 26, plugin 96).

## R4's inferred half, and R16's entry

**R4 — the projection is now reachable.** The official `workflow/*` seam carries no dependency structure, so
the only honest picture of a run this layer did not start is a projection from what the events did say:
which agents ran, in what order, under which phase. `contract_workflow_library action="observed"` exposes
exactly that — read-only, never gated:

| call | answer |
| --- | --- |
| `action="observed"` | the runs this layer has watched (`id`, `open`/`ended`, agent count, phases) |
| `action="observed", name="run-2"` | that run's topology as Mermaid, every edge stamped `inferred: phase-order` |
| observation off | `OBSERVATION_OFF` with the reason, **not** an empty graph that would read like a run with no agents |

The projected edges are drawn **dashed** and labelled as inferences, and the shape line says
`1 edge(s) (1 inferred, not declared)`. That is the whole point: a guess is never presented as a fact.
Note that only runs which emit `workflow/*` events can be seen — runs started by the host's own
`workflow` tool, not the ones this layer starts itself.

**R16 — the entry is an agent preset.** "A workflow mode that is not a normal chat" does not need a
client-UI slot plugin: DSH lists `<DSH_HOME>/.agent-presets/<id>/` in the new-session **preset selector**,
and this machine already ships five UltraMath presets and a `project-plugin-selector` that prove the
mechanism. So `presets/workflow/` ships here as a deliverable:

| file | what it is |
| --- | --- |
| `preset.yml` | `name: Workflow 工作模式` + description + `order` — what the selector shows |
| `agent.cordis.yml` | the standard composition (persona, fs/web/todo/skill tools, the delegation group with the official workflow rows, compaction) **plus this plugin's row at root level**, and a persona that teaches the mode: `find` first, declare contracts, never bypass a violation, save and record, respect the gate, read `observed` as inference |

Install it by copying the two FILES into the preset store, then restarting:

```powershell
$src = "<workspace>\local-plugins\dsh-workflow-governance\presets\workflow"
$dst = "$env:APPDATA\dsh-desktop\harness\.agent-presets\workflow"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item -Force "$src\preset.yml"       "$dst\preset.yml"
Copy-Item -Force "$src\agent.cordis.yml" "$dst\agent.cordis.yml"
```

> **Do NOT use `Copy-Item -Recurse <srcDir> <existingDstDir>` here.** Measured on this machine
> (2026-10-07): when the destination directory already exists, PowerShell copies the source
> directory *into* it — you get `<dst>\workflow\agent.cordis.yml` **while the real
> `<dst>\agent.cordis.yml` is left untouched**. The preset you edited is then never the one that
> loads, and a stray subdirectory is left inside a directory the registry scans. Copy the two
> files explicitly, as above.

**Two deployment facts that cost real time, both learned the hard way:**

1. **`tool-todo` needs `config.allowParallelInProgress`** in this build, or the entire preset fails to
   load with `agent preset <id>: tool-todo: invalid config: $.allowParallelInProgress missing required
   value`. The composition this file was derived from (`project-plugin-selector`) carries the same defect.
2. **The preset registry validates the migration BACKUPS too** (`<DSH_HOME>/.agent-presets/.persona-prefix-backups/<id>/`).
   So fixing the live copy is not enough: a stale backup of the same preset keeps the card at
   「加载失败」. That is also why a historical `project-plugin-selector: ... invalid config` warning kept
   appearing from 2026-10-05 — its live copy was long gone and only the backup remained to be validated.

And one more: **the app rewrites preset files at startup** (it migrated `persona.text` → `persona.prefix`
and stripped comments, 8666 B → 6354 B). The copy in this package is therefore the *source*, and the
store copy is a derived artifact — edit here and re-copy, never the other way round.

**A third deployment fact, measured 2026-10-07: that rewrite can TRUNCATE the file.** The live store
copy was found at 196 lines, ending on the two comment lines that introduce the governance row — the
`- id: workflow-governance` / `name: dsh-workflow-governance` pair was simply **gone**, and
`- id: tool-goal` had gone with it. The YAML stayed valid, so the registry reported nothing and the
preset still appeared in the selector; it just registered **no `contract_workflow` tool at all**. A
preset that parses but lost its plugin row is a *silent* failure — nothing anywhere says so.

`docs/workflow-mode/install-preset.ps1` exists for exactly that reason: it writes the live copy and
the backup from one source, then **asserts** that `- id: workflow-governance` (plus `tool-goal`, and
the `cordis:group` shell wrapper) survived, before it reports success.

When a preset fails to load, the answer is in `%APPDATA%\dsh-desktop\logs\harness.log` (the app holds the
file open, so read it through a shared handle; `ReadAllLines` will fail with "being used by another
process"). Search it for `agent-preset-registry`.
`bundle.test.mjs` pins its structure so a broken preset cannot ship: every row name must be a real
package of this deployment (`@deepseek-ai/*`, a `cordis:group`, or this package), this plugin's row must
sit at **root** level rather than inside the engine's isolate, and the persona must actually teach the
mechanism (`when`, `find`, `observed`, `gate_request`, `inferred`) instead of greeting the user.
## What the live acceptance found (four defects a passing suite did not)

The unit suite was green through all of these. Running the tools for real in a live session found them
anyway, which is the argument for doing it:

| # | symptom seen live | why it mattered | fix |
| --- | --- | --- | --- |
| 1 | `find` returned `decision ask · best demo` with **no score** | R12 is a *scored* decision; without the number the threshold that produced it cannot be checked | the card now carries `score 0.6667`, and `reason` when there is no candidate at all |
| 2 | `gate_status` returned a bare `completed` | R9 is "visible, then earned"; the card could not show *either* half | now `gate enabled · capabilities workflow:library:write:locked workflow:run:locked` |
| 3 | `gate_request` returned a bare `completed`, hiding the id | **functional, not cosmetic**: `gate_decide` needs that id, so a caller could ask and then be unable to finish the chain — the actual reason a multi-step acceptance run appeared not to close | the card now carries `request req-1 pending workflow:run` |
| 4 | the activation report was written *before* the stall detector ran, so `notes` was empty while D6 had not started | D6's outcome was unverifiable from the file that exists to verify it | the report is written at every exit from `apply()` and carries `detector` plus `timer` |

Two of the four are the same mistake in different clothes: **a summary that drops a field the next step
needs**. A tool card is an interface, and an interface that hides the identifier of the thing it just
created is broken even when every test passes.

Also confirmed live, and worth recording because it is a *design* limit rather than a bug: `save`
fail-closes on an edge with no `when` contract, and `projectGraph` — the only producer of
`inferred:phase-order` — is a library export that no tool calls. So the dashed inferred-edge rendering
has no live producer, which is exactly why R4 stays "declared half live, inferred half library-only".
## Changing the shell inside a PRESET composition: what works, and what breaks everything

Measured the hard way, three attempts, on a Windows machine where `bash` cannot run at all
(`/bin/bash` is absent, so the PTY dies at startup and EVERY command fails).

**The situation.** This preset's shell rows came from another preset (UltraMath) as a plain
`cordis:group` with `isolate: { terminals: true }`, holding `dsh-terminal` +
`dsh-terminal-bash` + `dsh-tool-bash-persistent`. On Windows that group is a trap twice over:
the group is its **own scope**, so the profile's own platform-gated rows (which DO give a
working `pwsh` to a standard session) are **not visible inside it** -- the session ends up
with the ungated `bash` and **no** `pwsh` at all.

**What works (verified live: `pwsh` appears, `bash` disappears, `echo hi` -> `hi`, exit 0).**
Keep the wrapper exactly as it is and change only the inner list:

```yaml
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: persistent-pwsh                      # the ONLY row inside
      name: '@deepseek-ai/dsh-tool-pwsh-persistent'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a PowerShell shell
          ...
```

**What breaks EVERY preset (do not do it).**

1. Replacing the `cordis:group` wrapper with a bare tool row. Tried it: every card in
   Settings -> Agent presets showed "加载失败". The wrapper is part of what the preset
   validator accepts; the inner list is the part you may change.
2. Putting `disabled:` or a `!!js` expression **inside** a preset composition. The official
   composition uses `!!js process.platform` -- but that is a **loader patch** (a bundle),
   not a preset composition, and the two are validated differently. This layer broke every
   preset once by copying that pattern in; the exact offending key was never isolated, so
   both are treated as forbidden here.

**The anchor trap.** In `profiles/web/cordis.patch.yml` the FIRST `- id: persistent-shell`
belongs to **UltraMath's** preset, not to this one. A search-and-replace that keys on the row
id alone silently edits the wrong preset and leaves yours unchanged -- which is exactly how
one of the three attempts "succeeded" while changing nothing that mattered. Anchor on a
comment that appears only in your own section.

The shell rows in this preset were copied from a shipped preset (UltraMath) that declares them as a plain
group:

```yaml
- id: persistent-shell
  name: cordis:group
  group: true
  isolate: { terminals: true }
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
```

On Windows that is fatal, and the failure is remote from the cause: the agent gets a **`bash`** tool whose
PTY backend resolves `DEFAULT_BASH_SHELL = "/bin/bash"` — a path that does not exist on Windows — so the
child shell exits before it is ready and every call returns
`Error: PTY shell exited during startup`, with no stdout and no exit code. Nothing about the *command* is
wrong; `echo hi` fails the same way.

The official composition does not ship a group at all. It gates each row by platform, in the row itself:

```yaml
- id: persistent-bash
  name: '@deepseek-ai/dsh-tool-bash-persistent'
  disabled: !!js process.platform === 'win32'

- id: persistent-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh-persistent'
  disabled: !!js process.platform !== 'win32'
```

So: **before reusing a composition from another preset, check every `disabled:` — a row that is correct on
the author's machine can be impossible on yours.** A preset definition carries `!!js` expressions like this
one (the loader evaluates them), which is why a platform gate belongs there and not in a comment.

Two notes on the repair itself. It has to be applied in **both** places a preset lives — the
`.agent-presets/<id>/agent.cordis.yml` **and** the inline copy inside `profiles/<name>/cordis.patch.yml`
that the legacy migration wrote and the harness actually mounts — and if you do it by search-and-replace,
anchor on something unique to the section you mean: the first `persistent-shell` in that patch belongs to
the **standard** composition, and editing that one leaves your own preset broken while looking fixed.
## What the layer ENFORCES, and what it only instructs

The workflow mode carries a ten-step protocol (library match -> split -> legal graph ->
instantiate -> isolated workers -> envelope/ACK -> grants -> routing -> tolerance ->
save -> delivery). Only part of that can be code-enforced here, and pretending otherwise
would be the worst possible documentation. The split, as measured:

**Enforced in code (a run cannot bypass it)**

- The match thresholds themselves: reuse at >= 0.80, ask at 0.60-0.80, create below
  (`matcher.js`), so step 1's decision is computed, not requested.
- Graph legality: exactly ONE start (a node with no incoming edge), at least one end, every
  node reachable from the start, every node able to reach an end, no duplicate id, no self
  edge, no cycle, and **every edge must declare `when`** -- unsupported schema keywords are
  refused at save time. An illegal graph is `INVALID_WORKFLOW`: it does not run.
- A missing node `label` is reported as **advice**, never a refusal: an instruction that
  silently invalidates the operator's existing library overnight is worse than a warning.
- Worker isolation: each node IS a separate subagent session, so workers cannot see each
  other's context -- that is the host's mechanism, not a promise here.
- Contract checking between nodes, send-back upstream, the retry budget, the verdict.
- `NESTED_WORKFLOW_REFUSED`: a node worker may not start another workflow (detected by the
  host's own `origin: 'subagent'` / `parentSession` marker, with reads still allowed).
- Automatic per-run scoring and the usage instance history; artifacts on disk.

**Only instructed (the model may deviate)**

- That the library is consulted FIRST (step 1's *sequence*), that a new graph is designed
  rather than improvised, that grants are requested before privileged actions, envelope /
  ACK / DLQ behaviour, budget circuit breakers, `pause`/`resume`/`revise`/`insert`
  intervention, WAL and worker-transcript archiving, and the `delivery/` hand-off.

**Enforced since the protocol landed**

- Node KINDS: `decision` (>= 2 outgoing edges, pairwise-distinct contracts, one branch must
  be a default), `join` (>= 2 incoming edges; `waitPolicy` accepts `all` only -- `any` and
  `n-of-m` are REFUSED rather than silently ignored), `end` (no outgoing edges), unknown
  kinds refused. Absent `kind` means `task`, so older graphs keep running unchanged.
- A declared `loop` is refused with the reason (this runner executes a DAG; an accepted-but-
  ignored loop would be worse than a refusal).
- A dead-letter queue: a spent retry budget records `{fromNode, toNode, edge, reason,
  attempts, errors}` and the card shows `dlq N (upstream->downstream: reason)`.

**Intervention, mapped onto what exists (and what cannot exist here)**

The protocol's step 8 asks for `pause` / `resume` / `cancel` / `revise <node>` /
`insert <node>` / `grant` / `status`. Of those:

- `revise` and `insert` ARE the library's `save` (it returns `CREATED` or `REPLACED`) plus a
  re-run by `name`: editing a stored graph and running it again is exactly the primitive.
- `status` is the recorded usage instance (`/history`) and the observed-run projection
  (`action="observed"`), both already available.
- `grant` is `gate_request` / `gate_decide`, with the reason mandatory in the request.
- `pause` / `resume` / `cancel` are **not implementable in this model**: a run is a single
  synchronous tool call, so there is no handle to suspend from the outside. Pretending
  otherwise would be a lie about the architecture, so it is refused by omission -- the
  operator stops it by not calling it.

A wall-clock budget is available as `budget.maxWallClockMs` in the plugin config (0, the
default, disables it). It is checked BEFORE each node spawn, so a run that would otherwise
go on forever is cut off with `BUDGET_EXCEEDED`, the node it stopped at, and a dead letter
naming the budget. A token budget is NOT implemented: this layer has no token accounting,
and inventing a threshold would be worse than admitting there is none.

**Not implemented at all (needs a data-model extension, not wording)**

- Node KINDS (`start`/`end`/`task`/`decision`/`join`) and exhaustive, mutually exclusive
  `decision` conditions with a default; `join` `wait_policy` (all/any/n-of-m); explicit
  `loop` subgraphs with `max_iterations`/`break_when` (cycles are refused outright today);
  per-node plugin allocation with interception and audit; message envelopes with ACK,
  exponential resend and a DLQ; token/time budget breakers.
## A preset session has no workspace, so its file root is DSH_HOME

Measured, and it answers a whole class of confusing reports: a session created with an **agent preset**
(a directory preset) has **no workspace mounted**, so its file tools are rooted at
`<DSH_HOME>` (`%APPDATA%\dsh-desktop\harness`) — the directory that holds `profiles/`, `cache/`,
`storages/` — not at the project you have open. Consequences, all observed:

| symptom | cause |
| --- | --- |
| a relative path like `docs/workflow-mode/LANDING-PLAN.md` is "not found" | it resolves under DSH_HOME, where there is no `docs/` |
| `glob "**/LANDING-PLAN.md"` returns nothing, and a whole-disk-looking grep matches nothing | the search is confined to DSH_HOME |
| `results/` (the artifact directory under this plugin) is invisible | it lives in the workspace, outside that root |
| the persistent shell fails to start (`PTY shell exited during startup`) | there is no workspace directory to run in |

The composition this preset was derived from (`project-plugin-selector`) has no workspace row either, and
neither do the shipped UltraMath presets — so this is a property of directory presets here, not a
mistake in this one file. **What to do about it:**

- In a preset session, **use absolute paths** (`<workspace>\docs\...`); they work, relative
  ones do not. Absolute reads outside the root are permitted.
- `artifacts.root` may be an **absolute** path, so artifacts can be written somewhere the session can see.
- Before reporting "the file does not exist", try the absolute path once. A node that only tries the
  relative path and gives up will produce a truthful "not found" for a file that is right there — which is
  exactly the report that started this section.

### The nonce pattern: verifying an answer a contract cannot verify

A contract constrains **shape**, never truth: `{ source: string, raw: string(minLength 50) }` is satisfied
equally well by a faithful excerpt and by a fluent invention about a file that was never read. When it
matters whether a node really read something, make the answer **unforgeable**: put a freshly generated
random value in the file, ask for it, and check that **two independent reads** return the same value.
Nothing in any prompt or context contains it, so a fabricated answer cannot hit it. `sample-nonce` is that
test as a runnable graph (`probe` and `verify` each open the file themselves and must agree).
## Three things that look like bugs and are not

All were reported against a working build, and all are design decisions worth stating rather than
leaving for the next reader to rediscover:

**1. `runs` / `ok` move on their own.** A run started by name (`{ name }`) records its own history —
`library.recordRun(...)` — because a graph that just failed is not a good reuse target. So the numbers
climb by themselves, and **a maintainer's acceptance runs move them too**. `record` is only for runs this
layer did NOT execute (a run started by the host's own `workflow` tool). A `score` of `0.0000` is not
drift either: `score = (0.5·label + 0.5·embedding) × (0.5 + 0.5·successRate)`, so an entry whose labels
do not intersect the query's, and whose text does not overlap it, scores exactly zero — `demo` queried
with `{labels:["sample"]}` scores 0, and the same entry queried with `{labels:["demo"]}` scores 0.75.

**2. `report` NEVER filters.** It always returns every entry; `query` only adds a score column — and that
is the point, because a dashboard that hides the entries that were not selected cannot show you *why*
they were not selected. Filtering is `find` (which scores and returns candidates).

**3a. A clip boundary needs a payload that is REQUIRED to cross it.** A first probe asked for "about 800
characters" from an 831-character file, and the node returned **exactly 600** with its own ellipsis — so the
clip never fired and nothing was proven. The fix is to demand the whole thing verbatim and check an end
marker, not a length: with a 2697-character file and "the complete content, ending exactly at
END-OF-PROBE-FILE", the card came back cut at 597 characters with `...`, which is the clip and nothing else.
(A card that is clipped can look like a channel limit or like sloppy generation; only a required,
checkable tail separates them.)
**3. Node payloads are clipped, and the clip says so.** The card returns up to 4 node payloads at 600
characters each. That limit is not cosmetic: a clipped payload is still **contract-compliant** — a
`points` array with a minimum but no maximum came back with its third item cut mid-word — and nothing in
the contract can see that damage. So the clip is never silent (`…[truncated: N chars total]`) and
`full: true` returns every payload verbatim. With `switches.resultArtifacts` on, the complete result
including all payloads is written to disk anyway.
## D6 works without an engine, and that is the whole point

An earlier version of this layer required `ctx.workflowEngine` before it would attach the stall
detector, so it recorded `detector: "waiting"` forever in the shipped composition. **That requirement
was wrong, and it was mine.** `WorkflowEngineAdapter` has two halves the host keeps apart:

| half | method | needs the engine? |
| --- | --- | --- |
| OBSERVATION | `attach()` — subscribes to the six `workflow/*` events with `{ global: true }` | **no** |
| CONTROL | `start()` — calls `engine.start(...)`, which this layer **never** does | yes |

The engine is isolated to the `delegation` group (`isolate: { workflowEngine: true }`), so a root-level
plugin can never reach it — but a `global` event listener still receives what it emits. Gating
observation on the engine therefore threw away the half that works, to protect a half that is never
used.

`engine` is now **optional** in the adapter (`controllable` reports which instance you have, and
`start()` without one throws a message naming what is missing). The plugin attaches observation
whenever `on` is available and records:

| `detector` | meaning |
| --- | --- |
| `off` | the switch is off |
| `attached` | observing, and the control seam is reachable too |
| `attached-observe-only` | **observing, engine isolated away — the live web profile's value** |
| `unavailable: ctx.on` / `unavailable: subscribe-failed` | nothing could be observed, with the reason |

The report also carries **`timer`**: `ctx` / `global` / `none` — where the periodic scan's timer came
from. That distinction is not pedantry: **timers are not part of cordis's core `Context`** (its
`lib/index.js` defines neither `setInterval` nor `setTimeout`), and the shipped deployment installs no
timer plugin, so `ctx.setInterval` is absent and a version of this layer that looked only for the
composition's timer would attach observation and then **never scan** — D6's actual point, silence
escalation, dead on arrival. It now falls back to the platform's timer, **unref'd** where supported (so a
diagnostic can never hold a process open) and **cleared on teardown** (so it cannot outlive the plugin).
With no timer anywhere it says so instead of pretending.

If the events never arrive the observer simply stays empty; this is read-only, so the downside of
attaching without an engine is nothing. A test starts a run on a **foreign** engine — one this plugin
holds no handle to — and asserts the periodic scan raises the stall after `escalateAfter` consecutive
silent scans.

Removing the engine requirement also removed the `internal/service` watcher and the
`waiting`/`attached-late` machinery that existed only to compensate for it: less code, fewer
subscriptions, same posture.

## R8 / R9 / R10 / R11: routing, the capability gate, and run artifacts

**R8 — a node routes itself.** A node may carry `agentOptions` (`provider` / `model` /
`reasoningEffort` / `maxTokens`), `toolFilter` (`allow` / `deny`), `persona` and `label`. They go on the
delegation request under exactly the names the host's own caller uses, so the provider sees what it
expects. A node carrying none of them sends only `label`, `parent`, `prompt` — no empty option bags.

**R9/R10 — visible, then earned.** With `switches.capabilityGate` on, two capabilities exist:

| capability | guards |
| --- | --- |
| `workflow:run` | executing a contract graph |
| `workflow:library:write` | `save` / `rename` / `remove` / `import` / `record` |

Reading the library (`list` / `get` / `find` / `diagram` / `export`) is **never** gated. That is R9: the
surface stays present and refuses *with a reason* instead of disappearing. An ungranted call returns
`status: "NOT_AUTHORIZED"` naming the capability, the agent and the exact way to ask, and **nothing is
spawned**. The ask/decide pair rides on the library tool as `gate_status` / `gate_request` /
`gate_decide`; a request without a reason is refused, because an unexplained request leaves no audit
trail worth having. `gate.allowOnce` (default true) is honoured because the check uses the
**consuming** `authorize()` — one approval buys exactly one run, and the next attempt is refused with
`CONSUMED`.

**The trust boundary, stated rather than hidden.** `gate_decide` cannot prove a *human* approved: in a
single-agent composition the caller and the decider are the same model, so the approval is **asserted,
then recorded** (`decidedBy`, reason, timestamps, audit log) — not cryptographically proven. A
deployment that needs a real human gate must put the decision behind its own approval surface and call
`gate_decide` from there. This is the same boundary the host's own sandbox-escalation flow has: the
layer can enforce *that a decision was recorded*, not *who made it*.

**R11 — the run is written to disk.** With `switches.resultArtifacts` on, every finished run appends one
JSON file under `artifacts.root`: the verdict (per-node attempts and violations included), the **full
topology**, and the Mermaid diagram. Writes are atomic, names are sanitised to a safe stem, the
directory is pruned to the `artifacts.maxFiles` newest, reads are confined to the root, and a failed
write is reported as an `artifact.error` field — never a throw, because a diagnostic must not change a
verdict.

**R4 — declared versus inferred, drawn differently.** A DECLARED edge carries a contract this layer can
enforce and is drawn as a solid arrow with that contract on it. An edge with no contract, or one
`observe.js` derived from phase order (the official `workflow/*` events carry no dependency structure),
is drawn **dashed** and labelled `inferred: …`; `describeGraph` mentions it only when there is a guess
to disclose. A guess is never presented as a fact.

**A worked example of why the diagram tests are shaped the way they are.** The first version emitted
`%% demo` (the title) as line 1. Mermaid accepts that and renders it — but a renderer that *detects* a
diagram before drawing reads the block's **first identifier** (`dsh-mermaid`:
`/^\s*([A-Za-z][\w-]*)/` against a keyword set starting with `flowchart`). `%` matches nothing, so the
fence would have been left as source code **forever, silently**. The declaration is now line 1 with the
title after it, and three tests derived from that heuristic fail if it ever moves back.

`lib/index.js` is covered by `test/bundle.test.mjs`, which asserts the properties that matter for
safety rather than the code path: no `@deepseek-ai` import/require anywhere in the sources, no
declared dependencies, an additive-only patch, and that the entry point loads in a bare node with no
host packages present. Everything with a decision in it lives in `src/plugin.js`, so the untested
surface is a 24-line shim with no branches beyond the three-way `defineTool` lookup.

Static compatibility of this bundle against this build's real service inventory
(129 services; `workflowEngine` present; no service collision):

```
python ../../docs/workflow-mode/probe-plugin-compat.py --plugin .
```

Expected: `VERDICT: STATIC-OK`, exit 0.

## Safety: why this package cannot repeat the `prepare` incident

A third-party plugin once pulled a **physical copy of `@deepseek-ai/dsh-tools`** into the profile.
Its tool-dispatcher Symbol is a different object from the host bundle's, so every tool call read
`undefined.prepare` and **every turn failed** ("本轮运行失败"). The repair was to keep that package
from ever landing in the profile.

This package is built so it cannot cause that again, and the properties are pinned by tests:

| Property | Why it matters | Guard |
| --- | --- | --- |
| **Zero declared dependencies** | nothing for the installer to materialise | `test/bundle.test.mjs` |
| **No `@deepseek-ai` import/require anywhere in the sources** | a static import gives the package manager a reason to resolve it into the profile | `test/bundle.test.mjs` |
| **The entry point loads with no host packages present** | proves the above end to end | `test/bundle.test.mjs` |
| **The bundle patch is additive only** | it must never disable, remove, or replace a native row — and in particular never insert the official `workflowEngine` (a second engine throws) | `test/bundle.test.mjs` |
| **It registers no service** | it cannot collide with one | `probe-plugin-compat.py` |
| **Every switch off by default** | installing it changes nothing observable | `test/plugin.test.mjs` |
| **FAIL SOFT on every host call** | a rejected registration, listener or timer degrades to a warning instead of breaking composition | `test/plugin.test.mjs` |
| **The tool is named `contract_workflow`, not `run_workflow`** | the host already has a `run_workflow`; shadowing native capability is forbidden | `test/plugin.test.mjs` |
| **`inject` is EMPTY** | see "Host facts" below: an `inject` key is a REQUIRED service, and a pending non-workbench entry is a **fatal startup error**. Declaring `workflowEngine` once stopped DSH from booting. | `test/plugin.test.mjs`, `test/bundle.test.mjs` |
| **every host surface is read via `readContext` / `ctx.get`** | reading an unprovided service property directly **throws** inside `apply()`, which is equally fatal | `test/plugin.test.mjs` (cordis-like double) |
| **no fake `defineTool`** | it validates and wraps a definition, so registering without the real one is refused rather than faked | `test/plugin.test.mjs`, `test/bundle.test.mjs` |
| **`apply()` is total** | it cannot throw in any composition, so the entry can never become a *failed* activation either | `test/plugin.test.mjs` |

## Host facts that constrain this plugin

Each was read out of the installed host code after a real incident — not assumed. Cite them before
changing anything here.

| Fact | Where | Consequence |
| --- | --- | --- |
| Every `inject` key is a **required** service; there is **no optional form** | `cordis/lib/index.js` `normalizeInject()`: `if (Array.isArray(inject)) for (const name of inject) result[name] = null` | listing a service this composition lacks leaves the plugin `pending` forever |
| An inactive entry is treated as **required**, and a required failure **throws `StartupError`** | `dsh-app-boot/lib/index.js` `auditStartupEntries()` | a pending plugin can stop DSH from starting at all |
| Only a **workbench** bundle is exempt — its failures become warnings | `dsh-app-boot/lib/index.js`: `owner.workbench = … bundleManifest.dsh?.client?.inject.includes("dsh-desktop-workbenches")` | installing through the plugin manager marks a plugin optional; `dsh plugin add` does not |
| Reading a service property the composition does **not** provide **throws** `cannot get property "x" without inject` | `cordis/lib/index.js` `ReflectService.handler.get`; only members on the target (methods such as `on`, and `get` itself) resolve normally | `ctx.tools` is free only because `tools` happens to exist — `ctx.workflowEngine` throws. Never read a service directly. |
| `ctx.get(name)` is the sanctioned escape — "Read a service from the store **without the inject requirement**" — returning `undefined` when nothing provides it | `cordis/lib/index.js` | the only safe way to ask for an optional service |
| `defineTool` is **not** an identity function: it validates and wraps `execute`, `finalizeContent`, `projectContent`, `output.render`, `presentCall` … into "a registry-ready definition" | `@deepseek-ai/dsh-tools/lib/index.js` | a raw definition must never reach the registry, so there is no honest fake for it |
| `output: { schema, render }` is **required** on a tool definition — `defineTool` reads `options.output.render` and `options.output.schema` first | `@deepseek-ai/dsh-tools/lib/index.js` | omitting `output` does not degrade: the tool never registers at all |
| The tool-schema DSL rejects unknown keywords, including `required` **directly on an `items` spec** | host registration error text | one bad keyword loses the whole tool; `test/plugin.test.mjs` now checks both specs against the DSL |
| The **spawner is `subagents`**, not `agents`: `agents` is only the registry (`store = new Map()`, `get(sessionId)`) | `@deepseek-ai/dsh-subagent` (`SubagentRuntime`) vs `@deepseek-ai/dsh-agent` | the official foreground call is `ctx.subagents.start(provider, { label, prompt: [blocks], parent, signal })` → `run.result` → `run.dispose()` |
| That request needs the **calling agent** as `parent` (the tool's `exec.agent`) | `@deepseek-ai/dsh-tool-subagent` | so a spawn is built per tool call, never once at activation |
| A subagent answers in **content blocks** and the run ends with a `stopReason` | same | a node's payload is the joined text parsed as a JSON object when it is one, `{ text }` otherwise (`parseNodeOutput`) |
| **`workflowEngine` is ISOLATED to the `delegation` group**: the shipped patch carries `isolate: { workflowEngine: true }` on that group, and `tool-workflow` sits inside it | `profiles/<name>/cordis.patch.yml` | a plugin **outside** that group can never see the engine — `ctx.get('workflowEngine')` stays `undefined` and the `internal/service` announcement never reaches it. This is the real reason `inject: ['workflowEngine']` produced a permanent `pending` (a fatal startup error), and why `inject = []` is not a workaround but the only correct declaration for a root-level plugin. |

Two mistakes were made here, and the log names both:

```
# 1. asking for a service the profile does not have
StartupError: dsh: startup failed: 1 required plugin did not activate
  workflow-governance (required)  workflowEngine
Error: failed to activate loader entry workflow-governance (dsh-workflow-governance):
       pending (waiting for service: workflowEngine)

# 2. then reading it directly after emptying `inject`
Error: cannot get property "defineTool" without inject
    at resolveDefineTool (lib/index.js:31:25)
    at new apply (lib/index.js:37:48)
```

So the rule has **two** halves, and neither alone is enough:

1. **`inject` stays empty** — the entry can then never sit `pending`, which is a fatal startup error
   for a non-workbench plugin.
2. **every host surface is read through `readContext(ctx, name)`**, which goes through `ctx.get` and
   only then falls back to a guarded direct read — so a missing service cannot throw inside `apply()`.

Together they make the entry impossible to leave inactive, which is why R7 and G1 also work in a
profile **without** a workflow engine: only the stall detector needs one.

`defineTool` follows the same discipline. `lib/index.js` resolves the host's real implementation
through exactly one guarded dynamic import and passes it down; when no real one exists the tool
surface stays **off** with a warning instead of registering something the host never validated.
`test/plugin.test.mjs` ships a context double that reproduces the inject trap, so a stray direct
service read fails the suite rather than the user's boot.

**Future hardening, deliberately not applied:** declaring
`dsh.client.inject: ["dsh-desktop-workbenches"]` would earn this bundle the workbench marker, making
*any* future activation failure a warning. It is left out because declaring `dsh.client` may require
shipping a browser half, and that is not verified. Add it only alongside a real load test.

Full removal is `dsh plugin --profile web remove dsh-workflow-governance`; nothing else references it.


## Activation self-report: how to tell whether it is actually working

The host writes a startup log **only when something fails**. A plugin that activates but registers
nothing therefore leaves *no trace anywhere* — which makes "is it working?" unanswerable from the
outside, and turns every diagnosis into a guess. So when at least one switch is on, this plugin
writes `state/startup.json` beside its own config (with every switch off it writes nothing at all,
so an inert install stays unobservable):

```
<plugin>/state/startup.json
```

```json
{
  "at": 1791305743305,
  "plugin": "workflow-governance",
  "contractVersion": 1,
  "enabled": { "contracts": true, "templateLibrary": true, "deadlockDetector": false, "...": false },
  "services": { "logger": true, "tools": true, "workflowEngine": false, "agents": true, "on": true, "setInterval": false },
  "defineTool": true,
  "registeredTools": ["contract_workflow", "contract_workflow_library"],
  "library": "<plugin>/library/library.json",
  "notes": []
}
```

Read it as:

| Field | Means |
| --- | --- |
| `defineTool` | the host's own `defineTool` was reachable. `false` is the single condition under which this plugin deliberately registers **nothing** |
| `registeredTools` | what the host's tool registry actually accepted — compare against the tool list in the GUI |
| `services` | **what the host really offered**, as opposed to what it documents. `"workflowEngine": false` explains a silent stall detector at a glance |
| `notes` | every warning the activation produced, in order |

Writing it is best-effort: if it cannot be written the failure is swallowed, because a diagnostic
must never be able to affect activation. `test/plugin.test.mjs` pins all four of those properties,
including that a blocked report path still leaves both tools registered.

`node examples/demo.mjs` prints a real report as its last section.

## R3: draw a workflow

`contract_workflow_library` with `action: "diagram"` renders a saved workflow as **Mermaid source**:

```
%% demo
flowchart LR
  n0["collect<br/>收集要点"]
  n1["synth<br/>汇总要点"]
  n0 -->|"required text; object; props text:string(min1); closed"| n1
```

The result carries `mermaid` (plain), `fenced` (a ```mermaid block) and `shape` (one line). **The card
renders the fenced block**, so a deployment that can draw Mermaid shows the diagram itself —
`dsh-mermaid` is installed in this profile, described as "Render Mermaid code blocks in DeepSeek
Harness with a diagram/code toggle". `direction: "LR"` orients it left-to-right.

**What it draws, and what it deliberately does not.** It draws the **declared** graph, so every arrow
carries its real data contract. It does **not** attempt a live run: the official `workflow/*` events
carry no dependency structure at all, so a run's topology could only be inferred as phase order —
`observe.js` marks those edges `inferred:phase-order`, and a picture built from them would mislead.
Drawing a run is possible once that inference is labelled on the diagram; that is the next step, not
a hidden approximation.

Escaping is the fragile part, and it is tested: only the characters that break a quoted Mermaid label
are neutralised (`"`, `[`, `]`, `{`, `}`, `|`, `<`, `>`); parentheses survive because a contract
summary needs them; newlines become `<br/>` *after* the strip pass so the markup cannot eat itself;
labels are clipped; dangling edges are skipped rather than inventing nodes.

## Degrade and roll back

- Turn a single switch off in the config file → that one feature becomes inert.
- `gate.setEnabled(false)` at runtime → same effect without a restart.
- Corrupt or invalid config with `loadConfig(path, { strict: false })` → falls back to
  the all-off defaults.
- Full rollback: delete this directory. Nothing else references it, and no global
  DSH state was written.
