import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, resolveConfig, inject, name, scoreRunReport, isWorkflowWorker, normalizeQuery, DEFAULT_CONFIG_PATH, startupReportPath, buildNodePrompt, textFromBlocks, parseNodeOutput, summarizeForModel, TOOL_NAME, LIBRARY_TOOL_NAME } from '../src/plugin.js';
import { defaultConfig } from '../src/config.js';
import { createFakeHost, goodRequest } from './fake-host.mjs';

/**
 * The `defineTool` double -- deliberately STRICT in the one way the host is.
 *
 * The host implementation opens with `options.output.render` and
 * `options.output.schema`, unconditionally, so a definition without `output`
 * throws and the tool never registers. An earlier permissive identity double
 * hid exactly that bug through a whole test suite and two user restarts; this one
 * cannot. Its first two lines are the host's first two lines.
 */
function hostShapedDefineTool(options) {
  const userRender = options.output.render;
  const outputSchema = options.output.schema;
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: outputSchema, render: (args, value) => userRender(args, value) },
    async execute(args, exec) {
      return options.execute(args, exec);
    },
  };
}
const DEFINE_TOOL = hostShapedDefineTool;

test('the defineTool double is strict about `output` -- otherwise it guards nothing', () => {
  assert.throws(
    () => DEFINE_TOOL({ name: 'x', description: 'd', parameters: {}, execute() {} }),
    /render/,
    'a definition without output must throw, exactly as the host does',
  );
  assert.doesNotThrow(() =>
    DEFINE_TOOL({ name: 'x', description: 'd', parameters: {}, output: { schema: { type: 'object' }, render: () => [] }, execute() {} }),
  );
});

function withTempConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wfg-plugin-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
  try {
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Async variant. The synchronous helper's `finally` would delete the temp dir
 * before an async body finished, so any test that awaits MUST use this one.
 */
async function withTempConfigAsync(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wfg-plugin-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
  try {
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const on = (over = {}) => {
  const cfg = defaultConfig();
  for (const [k, v] of Object.entries(over)) {
    if (k in cfg.switches) cfg.switches[k] = v;
    else Object.assign(cfg.deadlock, { [k]: v });
  }
  return cfg;
};

// The plugin takes an injectable clock, so time-based logic is driven, not waited on.
function clockHost(opts = {}) {
  const state = { t: 1_000_000 };
  return {
    state,
    now: () => state.t,
    advance: (ms) => { state.t += ms; },
    ...opts,
  };
}

// ───────────────────────────── the subagent payload contract (pure functions)

test('summarizeForModel shows the reason AND the per-node attempts', () => {
  // The two things a failure card must carry: why, and how hard it tried.
  const text = summarizeForModel({
    status: 'OUTPUT_VIOLATES_CONTRACT',
    upstream: 'collect',
    outputs: {},
    blocked: { edge: { from: 'collect', to: 'synth' }, upstream: 'collect', downstream: 'synth', errors: [{ path: '#/text', keyword: 'minLength', message: 'length 0 < 1' }] },
    nodeResults: { collect: { status: 'CONTRACT_VIOLATION', attempts: 2, output: { text: '' } } },
  });
  assert.match(text, /OUTPUT_VIOLATES_CONTRACT/);
  assert.match(text, /upstream collect/);
  assert.match(text, /length 0 < 1/, 'the contract error itself is on the card');
  assert.match(text, /collect:CONTRACT_VIOLATIONx2/, 'the retry count is on the card');
  // A NODE_FAILED card carries the thrown reason.
  assert.match(summarizeForModel({ status: 'NODE_FAILED', upstream: 'a', error: 'boom' }), /boom/);
  // Total: junk in, no throw.
  assert.equal(typeof summarizeForModel(undefined), 'string');
  assert.equal(typeof summarizeForModel({ nodeResults: 'nonsense' }), 'string');
  assert.doesNotThrow(() => summarizeForModel({ nodeResults: { a: null } }));
});

test('textFromBlocks joins text blocks and tolerates any other shape', () => {
  assert.equal(textFromBlocks([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(textFromBlocks([]), '');
  assert.equal(textFromBlocks(undefined), '');
  assert.equal(textFromBlocks('nonsense'), '');
  assert.equal(textFromBlocks([null, 42, { type: 'text', text: 7 }]), '');
});

test('parseNodeOutput unwraps JSON wherever the model put it, and falls back to { text }', () => {
  assert.deepEqual(parseNodeOutput('{"text":"hi"}'), { text: 'hi' });
  assert.deepEqual(parseNodeOutput('\n  {"a":1}  \n'), { a: 1 });
  assert.deepEqual(parseNodeOutput('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseNodeOutput('```\n{"a":1}\n```'), { a: 1 });

  // Reported live: a node answered with a fenced JSON object and the payload still
  // came back as `{ text: "```json…" }`, so every downstream consumer had to decode it
  // a second time. A sentence before the fence, a sentence after it, or a fence that
  // is not the entire answer must all still yield the object.
  assert.deepEqual(parseNodeOutput('结果如下：\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseNodeOutput('```json\n{"a":1}\n```\n以上。'), { a: 1 });
  assert.deepEqual(parseNodeOutput('好的，我给出对象：{"a":1} —— 完毕'), { a: 1 });
  // An array is a legitimate top-level payload; a contract may require one.
  assert.deepEqual(parseNodeOutput('[1,2]'), [1, 2]);
  assert.deepEqual(parseNodeOutput('```json\n[{"id":1}]\n```'), [{ id: 1 }]);

  // A prose answer is still a usable payload for a `{ text }` contract.
  assert.deepEqual(parseNodeOutput('the answer is 42'), { text: 'the answer is 42' });
  assert.deepEqual(parseNodeOutput('{ not json'), { text: '{ not json' });
  assert.deepEqual(parseNodeOutput(''), { text: '' });
  assert.deepEqual(parseNodeOutput(undefined), { text: '' });
});

// ─────────────────────── the host tool-schema DSL (registration is all-or-nothing)

/**
 * The keywords this DSL accepts, and the position rule that actually bit.
 *
 * The host REJECTS a whole tool definition when its parameter spec uses anything
 * unsupported, and the plugin then registers nothing at all -- so a schema
 * mistake is not a cosmetic warning, it is a missing tool. `required` directly on
 * an `items` spec is the shape that did it:
 *   `unsupported JSON schema: parameters.workflow.properties.nodes.items.required
 *    is not supported by the value schema DSL`
 */
const SUPPORTED_SPEC_KEYS = new Set(['type', 'description', 'required', 'enum', 'properties', 'items', 'additionalProperties']);

function walkSpec(spec, path, underItems, out) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return out;
  for (const key of Object.keys(spec)) {
    if (!SUPPORTED_SPEC_KEYS.has(key)) out.push(`${path}.${key} is not a supported spec keyword`);
    if (key === 'required' && underItems) out.push(`${path}.required is not supported on an items spec`);
  }
  if (spec.properties && typeof spec.properties === 'object') {
    for (const [childName, child] of Object.entries(spec.properties)) {
      walkSpec(child, `${path}.properties.${childName}`, false, out);
    }
  }
  if (spec.items !== undefined) walkSpec(spec.items, `${path}.items`, true, out);
  return out;
}

/** The root of `parameters` is a PROPERTY MAP (name -> spec), not a spec itself. */
function findDslViolations(parameterMap) {
  const out = [];
  if (parameterMap === null || typeof parameterMap !== 'object') return out;
  for (const [paramName, spec] of Object.entries(parameterMap)) {
    walkSpec(spec, `parameters.${paramName}`, false, out);
  }
  return out;
}

test('the DSL guard catches the exact shape that broke registration', () => {
  const bad = { workflow: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', required: true } } } } };
  assert.match(
    findDslViolations(bad).join('\n'),
    /parameters\.workflow\.properties\.nodes\.items\.required/,
    'the guard must reproduce the host message path',
  );
  assert.deepEqual(findDslViolations({ action: { type: 'string', required: true } }), [], 'a normal spec is clean');
});

test('SAFETY: both parameter specs stay inside the host DSL, so neither tool can fail to register', () => {
  withTempConfig(on({ contracts: true, templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(byName.size, 2, 'both tools registered, so both specs were accepted by the strict double');
    for (const [toolName, definition] of byName) {
      assert.deepEqual(findDslViolations(definition.parameters), [], `${toolName} parameters must be DSL-clean`);
      assert.ok(!('required' in definition.output.schema), `${toolName} output.schema is a value schema and carries no required`);
      assert.equal(typeof definition.output.render, 'function', `${toolName} must supply a renderer`);
    }
    // `workflow` must NOT be required: `name` is the alternative, and the host
    // validates arguments before execute runs, so marking it required would make
    // "run a saved workflow by name" impossible.
    assert.ok(!byName.get(TOOL_NAME).parameters.workflow.required, 'workflow must stay optional');
    assert.ok(!byName.get(TOOL_NAME).parameters.name.required, 'name must stay optional');
  });
});

test('R14: calling with neither workflow nor name is a structured refusal, not a crash', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await byName.get(TOOL_NAME).execute({});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'INVALID_WORKFLOW');
    assert.match(result.problems[0].message, /or `name`/);
  });
});

test('R3: the library tool draws a saved workflow, and the card carries the fenced source', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    await lib.execute({ action: 'save', definition: { name: 'drawn', ...savedGraph() } });

    const out = await lib.execute({ action: 'diagram', name: 'drawn', direction: 'LR' });
    assert.equal(out.ok, true);
    assert.equal(out.code, 'DIAGRAM');
    assert.match(out.mermaid, /^flowchart LR$/m);
    assert.match(out.mermaid, /collect/);
    assert.match(out.mermaid, /required text/, 'the edge contract is on the arrow');
    assert.equal(out.shape, '2 node(s), 1 edge(s) · start collect · end synth');

    // The render is what the user sees; it must be the fenced block, or a
    // Mermaid renderer has nothing to draw.
    const rendered = lib.output.render({}, out);
    assert.equal(rendered[0].type, 'text');
    assert.match(rendered[0].text, /^```mermaid\n(%%[^\n]*\n)?flowchart LR/);
    assert.match(rendered[0].text, /\n```$/);

    // Default orientation, and a name that is not in the library.
    assert.match((await lib.execute({ action: 'diagram', name: 'drawn' })).mermaid, /^flowchart TD$/m);
    assert.equal((await lib.execute({ action: 'diagram', name: 'ghost' })).code, 'NOT_FOUND');
  });
});

test('R3: the diagram direction parameter stays inside the DSL (enum only)', () => {
  withTempConfig(on({ templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const params = byName.get(LIBRARY_TOOL_NAME).parameters;
    assert.deepEqual(findDslViolations(params), []);
    assert.deepEqual(params.direction.enum, ['TD', 'LR'], 'orientation is a plain enum, which the DSL supports');
    assert.match(params.action.description, /diagram/);
  });
});

// ─────────────────────────────────── R8: a node routes itself (provider/model/tools)

test('R8: node-level routing options reach the delegation request verbatim', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await tools.registered[0].execute({
      workflow: {
        nodes: [{
          id: 'a',
          prompt: 'do a',
          label: 'gather the facts',
          agentOptions: { provider: 'deepseek', model: 'deepseek-v4-1-flash-260910', reasoningEffort: 'high' },
          toolFilter: { allow: ['read', 'glob'], deny: ['terminal'] },
          persona: 'a terse researcher',
        }],
        edges: [],
      },
    }, PARENT_EXEC);
    assert.equal(result.status, 'COMPLETED');
    const request = subagents.started[0].request;
    assert.equal(request.label, 'gather the facts', 'a node names its own run');
    assert.deepEqual(request.agentOptions, { provider: 'deepseek', model: 'deepseek-v4-1-flash-260910', reasoningEffort: 'high' });
    assert.deepEqual(request.toolFilter, { allow: ['read', 'glob'], deny: ['terminal'] }, 'a node can be restricted to a tool set');
    assert.equal(request.persona, 'a terse researcher');
  });
});

test('R8: a plain node sends only the fields the provider expects', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    await tools.registered[0].execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, PARENT_EXEC);
    const request = subagents.started[0].request;
    assert.deepEqual(Object.keys(request).sort(), ['label', 'parent', 'prompt'], 'no empty option bags are sent');
    assert.equal(request.label, 'workflow node a');
  });
});

// ───────────────────────────────────── R11: a finished run is written to disk

test('R11: with the switch on a run writes its verdict, topology and diagram', async () => {
  await withTempConfigAsync(on({ contracts: true, templateLibrary: true, resultArtifacts: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ collect: { text: 'seed' }, synth: { text: 'done' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    await lib.execute({ action: 'save', definition: { name: 'flow-a', ...savedGraph() } });

    const run = await byName.get(TOOL_NAME).execute({ name: 'flow-a' }, PARENT_EXEC);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(typeof run.artifact.path, 'string');
    const payload = JSON.parse(readFileSync(run.artifact.path, 'utf8'));
    assert.equal(payload.name, 'flow-a');
    assert.equal(payload.graph.nodes.length, 2, 'the full topology is saved');
    assert.equal(payload.graph.edges[0].when.required[0], 'text', 'the edge contract survives');
    assert.match(payload.diagram, /^flowchart TD/, 'R3 output travels with the artifact');
    assert.equal(payload.result.status, 'COMPLETED');
    assert.deepEqual(run.artifact.pruned, []);
  });
});

test('R11: with the switch off no artifact directory is created at all', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ collect: { text: 'seed' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const run = await byName.get(TOOL_NAME).execute({
      workflow: { nodes: [{ id: 'collect', prompt: 'do collect' }], edges: [] },
    }, PARENT_EXEC);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.artifact, undefined, 'nothing is reported when the feature is off');
    assert.equal(existsSync(join(dirname(file), 'results')), false, 'and nothing is written');
  });
});

test('R11: an unwritable artifact is reported as a field, and the run verdict stands', async () => {
  await withTempConfigAsync(on({ contracts: true, resultArtifacts: true }), async (file) => {
    // A FILE where the results directory must go.
    writeFileSync(join(dirname(file), 'results'), 'in the way', 'utf8');
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ collect: { text: 'seed' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const run = await byName.get(TOOL_NAME).execute({
      workflow: { nodes: [{ id: 'collect', prompt: 'do collect' }], edges: [] },
    }, PARENT_EXEC);
    assert.equal(run.status, 'COMPLETED', 'the run still succeeded');
    assert.equal(typeof run.artifact.error, 'string', 'the failure is visible, not thrown');
    assert.match(host.logs.warn.join('\n'), /could not write the run artifact/);
  });
});

test('the find summary carries the score, because the decision is scored', () => {
  // Found by running a live `find`: the card said `decision ask · best demo` with
  // no number, so the threshold that produced the decision could not be checked.
  const scored = summarizeForModel({
    decision: 'ask',
    reason: 'best-score=0.7441',
    best: { id: 'demo', score: 0.7441 },
    candidates: [],
  });
  assert.match(scored, /decision ask/);
  assert.match(scored, /best demo/);
  assert.match(scored, /score 0\.7441/, 'the score must be visible');
  assert.doesNotMatch(scored, /best-score=/, 'the internal reason duplicates the score');

  // With no candidate, the reason is what distinguishes an empty library from one
  // whose entries simply did not score high enough.
  const empty = summarizeForModel({ decision: 'create', reason: 'empty-library', best: null, candidates: [] });
  assert.match(empty, /decision create/);
  assert.match(empty, /empty-library/);
});

test('the gate_status card shows the gate state and each capability lock', () => {
  // Found by calling `gate_status` live: the card said only "completed", so R9's
  // "visible, then earned" could not be read off the tool result at all.
  const off = summarizeForModel({ ok: true, enabled: false, agentId: 'agent-1', capabilities: [] });
  assert.match(off, /gate disabled/);
  assert.match(off, /capabilities none/);

  const on = summarizeForModel({
    ok: true,
    enabled: true,
    agentId: 'agent-1',
    capabilities: [
      { capability: 'workflow:run', usable: false, assigned: false, visible: true },
      { capability: 'workflow:library:write', usable: true, assigned: true, visible: true },
    ],
  });
  assert.match(on, /gate enabled/);
  assert.match(on, /workflow:run:locked/);
  assert.match(on, /workflow:library:write:usable/);
});

test('the gate_request card carries the id the decide step needs', () => {
  // Found LIVE, and it is not cosmetic: the card said only "completed" while the
  // request id was `req-1`. Without the id on the card, the caller that just asked
  // cannot call `gate_decide`, so R10's chain cannot close at all.
  const asked = summarizeForModel({
    ok: true,
    request: { id: 'req-1', capability: 'workflow:run', status: 'pending', requestedBy: 'session-x' },
  });
  assert.match(asked, /request req-1/);
  assert.match(asked, /pending/);
  assert.match(asked, /workflow:run/);

  const decided = summarizeForModel({ ok: true, status: 'approved', request: { id: 'req-1', status: 'granted' } });
  assert.match(decided, /status approved/, 'the decision itself is still shown');
  assert.match(decided, /request req-1/);

  // A payload with no request must not grow a stub "request ?" line.
  assert.doesNotMatch(summarizeForModel({ ok: true, entries: [] }), /request \?/);
});

// ─────────── the library dashboard: one call that shows the whole library

test('`report` shows the whole library: size, revision, history and score', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    await lib.execute({ action: 'save', definition: { name: 'alpha', labels: ['demo'], ...savedGraph() } }, PARENT_EXEC);
    await lib.execute({ action: 'save', definition: { name: 'beta', ...savedGraph() } }, PARENT_EXEC);
    await lib.execute({ action: 'record', name: 'alpha', success: true }, PARENT_EXEC);
    await lib.execute({ action: 'record', name: 'alpha', success: false }, PARENT_EXEC);

    const plain = await lib.execute({ action: 'report' }, PARENT_EXEC);
    assert.equal(plain.code, 'REPORT');
    assert.equal(plain.entries.length, 2);
    assert.equal(plain.query, null);

    const alpha = plain.entries.find((e) => e.name === 'alpha');
    assert.equal(alpha.nodes, 2);
    assert.equal(alpha.edges, 1);
    assert.equal(typeof alpha.revision, 'number');
    assert.equal(alpha.runs, 2);
    assert.equal(alpha.successes, 1);
    assert.equal(alpha.successRate, 0.5, 'a half-failed graph must not look reliable');
    assert.equal(alpha.historyFactor, 0.75, '0.5 + 0.5 * 0.5');
    assert.equal(alpha.score, null, 'no query, no score: do not invent one');
    assert.deepEqual(alpha.labels, ['demo']);

    // With a query the dashboard must agree with the decision tool it summarises.
    const query = { name: 'alpha', labels: ['demo'] };
    const scored = await lib.execute({ action: 'report', query }, PARENT_EXEC);
    const a2 = scored.entries.find((e) => e.name === 'alpha');
    const found = await lib.execute({ action: 'find', query }, PARENT_EXEC);
    assert.equal(typeof a2.score, 'number');
    assert.equal(a2.score, Number(found.best.score.toFixed(4)));
    // With a query every entry is scored, not just the winner: the dashboard is how a
    // near-miss becomes visible instead of being silently dropped by the threshold.
    assert.equal(typeof scored.entries.find((e) => e.name === 'beta').score, 'number');

    // An entry with no history cannot have a success rate; n/a is not 0.
    const beta = plain.entries.find((e) => e.name === 'beta');
    assert.equal(beta.successRate, null);
    assert.equal(beta.historyFactor, 1, 'no history means no penalty');
  });
});

test('the report card is one readable line per entry', () => {
  const line = summarizeForModel({
    ok: true,
    code: 'REPORT',
    query: null,
    entries: [
      { name: 'alpha', nodes: 2, edges: 1, revision: 3, runs: 2, successes: 1, successRate: 0.5, historyFactor: 0.75, score: 0.6667 },
      { name: 'beta', nodes: 1, edges: 0, revision: null, runs: 0, successes: 0, successRate: null, historyFactor: 1, score: null },
    ],
  });
  assert.match(line, /alpha 2n\/1e rev3 runs 2 ok 1 rate 0\.5 score 0\.6667/);
  assert.match(line, /beta 1n\/0e rev\? runs 0 ok 0 rate n\/a/);
  assert.doesNotMatch(line, /beta[^|]*score/, 'an unscored entry must not show a score');
});

test('R4: with no per-agent phase in the events, only a strictly sequential pair is chained', async () => {
  await withTempConfigAsync(on({ templateLibrary: true, deadlockDetector: true }), async (file) => {
    const clock = clockHost();
    const host = createFakeHost({ withTimer: true });
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    // The live shape: agents carry NO phase, so phase chaining yields no edges. Here
    // a1 runs and ENDS before a2 starts -- a real observation, chainable.
    const run = host.engine.start(goodRequest());
    run.startAgent(1);
    run.endAgent(1, 'completed');
    clock.advance(1000);
    run.startAgent(2);
    run.endAgent(2, 'completed');

    const one = await lib.execute({ action: 'observed', name: run.id }, PARENT_EXEC);
    assert.equal(one.code, 'OBSERVED_GRAPH');
    assert.equal(one.edgesSource, 'inferred:start-order');
    assert.match(one.fenced, /-\.->\|"inferred: start-order"\|/, 'still dashed, and it says WHY it was drawn');
    assert.ok(!/ --> /.test(one.fenced), 'never drawn as a declared edge');

    // Two agents that OVERLAP are a fan-out: no dependency may be invented.
    const fan = host.engine.start(goodRequest());
    fan.startAgent(1); // t
    clock.advance(10);
    fan.startAgent(2); // t+10 -- starts BEFORE 1 ends
    clock.advance(10);
    fan.endAgent(1, 'completed'); // t+20
    fan.endAgent(2, 'completed');
    const fanOut = await lib.execute({ action: 'observed', name: fan.id }, PARENT_EXEC);
    assert.equal(fanOut.edgesSource.startsWith('none'), true, 'overlap means "cannot tell", not a chain');
    assert.equal(fanOut.fenced.includes('-.->'), false, 'no edge at all for a fan-out');
  });
});

// ─────────────── R4's inferred half: reachable from a session at last

test('R4: `observed` says observation is off instead of returning an empty graph', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const res = await byName.get(LIBRARY_TOOL_NAME).execute({ action: 'observed' }, PARENT_EXEC);
    assert.equal(res.code, 'OBSERVATION_OFF', 'an empty graph would read like a run with no agents');
    assert.match(res.message, /deadlockDetector/);
  });
});

test('R4: a run watched through the official seam projects to a DASHED inferred graph', async () => {
  await withTempConfigAsync(on({ templateLibrary: true, deadlockDetector: true }), async (file) => {
    const host = createFakeHost({ withTimer: true });
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    // A run this layer did NOT start: the host's own engine emits the events, and
    // those events carry no dependency structure -- only order and phases.
    const run = host.engine.start(goodRequest());
    run.phase('collect');
    run.startAgent(1, { phase: 'collect' });
    run.phase('synth');
    run.startAgent(2, { phase: 'synth' });

    const list = await lib.execute({ action: 'observed' }, PARENT_EXEC);
    assert.equal(list.code, 'OBSERVED_RUNS');
    assert.equal(list.runs.length, 1);
    assert.equal(list.runs[0].id, run.id);
    assert.equal(list.runs[0].agents, 2);
    assert.deepEqual(list.runs[0].phases, ['collect', 'synth']);
    assert.equal(list.runs[0].status, 'open');

    const one = await lib.execute({ action: 'observed', name: run.id }, PARENT_EXEC);
    assert.equal(one.code, 'OBSERVED_GRAPH');
    assert.equal(one.edgesSource, 'inferred:phase-order');
    assert.match(one.shape, /1 edge\(s\) \(1 inferred, not declared\)/, 'the shape line counts the guesses');
    assert.match(one.fenced, /```mermaid/);
    assert.match(one.fenced, /-\.->\|"inferred: phase-order"\|/, 'a guess is dashed AND labelled as one');
    assert.ok(!/ --> /.test(one.fenced), 'nothing in a projected graph pretends to be declared');
    assert.match(one.fenced, /phase collect/, 'the label describes the observed identity, not invented content');

    assert.equal((await lib.execute({ action: 'observed', name: 'run-999' }, PARENT_EXEC)).code, 'NOT_FOUND');
  });
});

test('R4: `observed` is never gated, because it only reads', async () => {
  await withTempConfigAsync(on({ templateLibrary: true, deadlockDetector: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost({ withTimer: true });
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const res = await byName.get(LIBRARY_TOOL_NAME).execute({ action: 'observed' }, PARENT_EXEC);
    assert.equal(res.code, 'OBSERVED_RUNS', 'reading stays usable with the capability gate on');
  });
});

test('a clipped payload says so, and `full` returns all of it', () => {
  // Found live: a `points` array (its contract had a minimum but no length bound) came
  // back with its third item cut mid-word at 600 chars. The contract was satisfied and
  // the content was amputated -- damage nothing else can see. So the clip must announce
  // itself, and there must be a way to ask for the whole thing.
  const long = `{"points":["${'x'.repeat(2000)}"]}`;
  const clipped = summarizeForModel({ status: 'COMPLETED', outputs: { digest: long } });
  assert.match(clipped, /truncated: \d+ chars total/, 'the card must name the total size');
  assert.match(clipped, /full: true/, 'and say how to get the rest');
  assert.ok(clipped.length < long.length, 'the default stays small');

  const whole = summarizeForModel({ status: 'COMPLETED', outputs: { digest: long } }, { full: true });
  assert.ok(whole.includes(long), 'full: true returns the payload verbatim');
  assert.doesNotMatch(whole, /truncated:/);

  const short = summarizeForModel({ status: 'COMPLETED', outputs: { a: '{"text":"ok"}' } });
  assert.match(short, /a = \{"text":"ok"\}/);
  assert.doesNotMatch(short, /truncated:/);
});

// ──────────────────────────── R9/R10: the capability gate (visible, then earned)

test('R9/R10: with the gate off nothing is refused -- the layer adds no permission layer', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const run = await byName.get(TOOL_NAME).execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, PARENT_EXEC);
    assert.equal(run.status, 'COMPLETED', 'no grant is needed when the gate is off');
  });
});

test('R9/R10: with the gate on an ungranted run is refused, and nothing is spawned', async () => {
  await withTempConfigAsync(on({ contracts: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });

    const run = await byName.get(TOOL_NAME).execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, PARENT_EXEC);
    assert.equal(run.status, 'NOT_AUTHORIZED');
    assert.equal(run.capability, 'workflow:run');
    assert.equal(run.agentId, PARENT_EXEC.agent.id);
    assert.match(run.message, /gate_request/, 'the refusal says exactly how to ask');
    assert.equal(subagents.started.length, 0, 'a refused call must not spawn anything');
  });
});

test('R9: reading stays usable while mutating is refused -- the point of "visible, not usable"', async () => {
  await withTempConfigAsync(on({ templateLibrary: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    assert.equal((await lib.execute({ action: 'list' }, PARENT_EXEC)).ok, true, 'reading is never gated');
    assert.equal((await lib.execute({ action: 'diagram', name: 'ghost' }, PARENT_EXEC)).code, 'NOT_FOUND', 'reached the action, not the gate');

    const write = await lib.execute({ action: 'save', definition: { name: 'x', ...savedGraph() } }, PARENT_EXEC);
    assert.equal(write.status, 'NOT_AUTHORIZED');
    assert.equal(write.capability, 'workflow:library:write');
    // And the surface lists what exists but may not be used yet.
    const status = await lib.execute({ action: 'gate_status' }, PARENT_EXEC);
    assert.equal(status.enabled, true);
    assert.deepEqual(status.capabilities.map((c) => c.capability), ['workflow:library:write', 'workflow:run']);
    assert.deepEqual(status.capabilities.map((c) => c.usable), [false, false]);
  });
});

test('R10: ask, decide, then use -- and an approval is spent by default', async () => {
  await withTempConfigAsync(on({ contracts: true, templateLibrary: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    const graph = { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] };

    // An unexplained request is refused: the reason is the audit trail's substance.
    assert.equal((await lib.execute({ action: 'gate_request', capability: 'workflow:run' }, PARENT_EXEC)).code, 'REASON_REQUIRED');
    assert.equal((await lib.execute({ action: 'gate_request', capability: 'workflow:nonsense', reason: 'x' }, PARENT_EXEC)).code, 'UNKNOWN_CAPABILITY');
    assert.equal((await lib.execute({ action: 'gate_decide', requestId: 'req-999', approve: true }, PARENT_EXEC)).code, 'UNKNOWN_REQUEST');

    const asked = await lib.execute({ action: 'gate_request', capability: 'workflow:run', reason: 'the task needs a contract-governed graph' }, PARENT_EXEC);
    assert.equal(asked.ok, true);
    assert.match(asked.request.id, /^req-\d+$/);
    assert.equal(asked.request.status, 'pending');
    assert.equal((await byName.get(TOOL_NAME).execute({ workflow: graph }, PARENT_EXEC)).status, 'NOT_AUTHORIZED', 'still pending, still refused');

    const decided = await lib.execute({ action: 'gate_decide', requestId: asked.request.id, approve: true, approvedBy: 'the operator' }, PARENT_EXEC);
    assert.equal(decided.ok, true);

    const first = await byName.get(TOOL_NAME).execute({ workflow: graph }, PARENT_EXEC);
    assert.equal(first.status, 'COMPLETED', 'the approved run proceeds');
    // allowOnce is the default, so one approval bought exactly one run.
    const second = await byName.get(TOOL_NAME).execute({ workflow: graph }, PARENT_EXEC);
    assert.equal(second.status, 'NOT_AUTHORIZED');
    assert.equal(second.code, 'CONSUMED', 'the approval was spent, which is what allowOnce means');
  });
});

test('R10: a denial is recorded and the capability stays refused', async () => {
  await withTempConfigAsync(on({ contracts: true, templateLibrary: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    const asked = await lib.execute({ action: 'gate_request', capability: 'workflow:run', reason: 'because' }, PARENT_EXEC);
    await lib.execute({ action: 'gate_decide', requestId: asked.request.id, approve: false, approvedBy: 'the operator', reason: 'not now' }, PARENT_EXEC);

    const run = await byName.get(TOOL_NAME).execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, PARENT_EXEC);
    assert.equal(run.status, 'NOT_AUTHORIZED');
    assert.equal(run.code, 'REQUEST_DENIED', 'the refusal names the denial, not a vague failure');
    assert.equal(subagents.started.length, 0);
    // A second decision on the same request is refused rather than silently re-deciding.
    assert.equal((await lib.execute({ action: 'gate_decide', requestId: asked.request.id, approve: true }, PARENT_EXEC)).code, 'ALREADY_DECIDED');
  });
});

test('R9/R10: a gated call with no calling agent is refused, never allowed by default', async () => {
  await withTempConfigAsync(on({ contracts: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const run = await byName.get(TOOL_NAME).execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, {});
    assert.equal(run.status, 'NOT_AUTHORIZED');
    assert.equal(run.code, 'NO_CALLER', 'fail-closed when identity is missing');
  });
});

test('R9/R10: the gate actions themselves need no grant, or nobody could ever ask', async () => {
  await withTempConfigAsync(on({ templateLibrary: true, capabilityGate: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    assert.equal((await lib.execute({ action: 'gate_status' }, PARENT_EXEC)).enabled, true);
    assert.equal((await lib.execute({ action: 'gate_request', capability: 'workflow:run', reason: 'x' }, PARENT_EXEC)).ok, true);
    // `gate_decide` is deliberately not gated either: see the trust note in the README.
    assert.equal((await lib.execute({ action: 'gate_decide', requestId: 'req-1', approve: true }, PARENT_EXEC)).ok, true);
  });
});

test('R9/R10: with the gate off both gate actions report that nothing needs requesting', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    assert.equal((await lib.execute({ action: 'gate_request', capability: 'workflow:run', reason: 'x' }, PARENT_EXEC)).code, 'GATE_DISABLED');
    assert.equal((await lib.execute({ action: 'gate_decide', requestId: 'req-1', approve: true }, PARENT_EXEC)).code, 'GATE_DISABLED');
    assert.deepEqual((await lib.execute({ action: 'gate_status' }, PARENT_EXEC)).capabilities, []);
  });
});

// ───────── D6 needs no engine: the observation half is independent of control

test('D6: observation attaches with NO engine at all, because attach() is global-only', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    host.ctx.workflowEngine = undefined; // isolated away from this plugin, as shipped
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });

    // The six workflow events are subscribed even though the engine is unreachable:
    // `attach()` uses `ctx.on(..., { global: true })`, and the engine object is only
    // ever touched by the control half, which this layer never calls.
    assert.equal(host.subscriptions.length, 6, 'the six observe-only events');
    for (const sub of host.subscriptions) assert.match(sub.name, /^workflow\//);
    assert.equal(typeof disposer, 'function');
    assert.doesNotThrow(() => disposer());
  });
});

test('D6: a run emitted by a foreign engine is observed and can raise a stall', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const clock = clockHost();
    const host = createFakeHost({ withTimer: true });
    // The engine is the ONLY producer of events; this plugin holds no handle to it.
    const { engine } = host;
    host.ctx.workflowEngine = undefined;
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });

    const run = engine.start(goodRequest());
    run.startAgent(1);
    assert.equal(host.subscriptions.length, 6, 'still just the observation');

    // Silence past the idle timeout, then the periodic scan must escalate after
    // `escalateAfter` consecutive stalled scans.
    const timer = host.timers[0];
    assert.ok(timer, 'the periodic scan is armed');
    clock.advance(61_000);
    timer.fn();
    timer.fn();
    timer.fn();
    assert.match(host.logs.warn.join('\n'), /stall|silent|no progress|停在|停滞/i, 'a silent run is reported');
  });
});

// ───────────────────── D6 in the report: the detector's own outcome, on file

const readReport = (file) => JSON.parse(readFileSync(startupReportPath(file), 'utf8'));

test('D6 REPORT: the switch off records "off"', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(readReport(file).detector, 'off');
  });
});

test('D6 REPORT: an engine already present records "attached"', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost();
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(readReport(file).detector, 'attached');
    assert.equal(readReport(file).services.workflowEngine, true);
  });
});

test('D6 REPORT: an engine isolated away still yields "attached-observe-only"', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    host.ctx.workflowEngine = undefined;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const report = readReport(file);
    // This is the live web profile's shape, and it is not a failure: the six global
    // listeners are attached, only the control seam is missing.
    assert.equal(report.detector, 'attached-observe-only');
    assert.equal(report.services.workflowEngine, false, 'the apply-time reading is recorded as it was');
    assert.deepEqual(report.notes, [], 'nothing to warn about: observation is complete');
  });
});

test('D6 REPORT: with no way to observe, the report says exactly that', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const logs = { info: [], warn: [] };
    const ctx = {
      logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) },
      workflowEngine: { start() {} },
      // no `on` at all
    };
    apply(ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(readReport(file).detector, 'unavailable: ctx.on');
  });
});

// ─────────────────────────────── activation self-report (diagnosis, not guesswork)

test('REPORT: with every switch off nothing is written at all -- still unobservable', () => {
  withTempConfig(on({}), (file) => {
    const host = createFakeHost();
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(existsSync(startupReportPath(file)), false, 'an inert plugin must leave no trace');
    assert.equal(existsSync(join(dirname(file), 'state')), false, 'not even the directory');
  });
});

test('REPORT: with a switch on it records exactly what the host offered and what registered', () => {
  withTempConfig(on({ contracts: true, templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const report = JSON.parse(readFileSync(startupReportPath(file), 'utf8'));
    assert.equal(report.plugin, 'workflow-governance');
    assert.equal(report.defineTool, true, 'the host defineTool was reachable');
    assert.deepEqual(report.registeredTools, [TOOL_NAME, LIBRARY_TOOL_NAME]);
    assert.equal(report.services.tools, true);
    assert.equal(report.services.workflowEngine, true, 'the fake host does expose an engine');
    assert.equal(typeof report.at, 'number');
    assert.deepEqual(report.notes, [], 'a clean activation has nothing to report');
    assert.deepEqual([...byName.keys()], report.registeredTools, 'the report matches reality');
  });
});

test('REPORT: it names the one condition under which nothing registers', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file }); // no defineTool reachable
    const report = JSON.parse(readFileSync(startupReportPath(file), 'utf8'));
    assert.equal(report.defineTool, false);
    assert.deepEqual(report.registeredTools, []);
    assert.equal(byName.size, 0);
    assert.match(report.notes.join('\n'), /defineTool is unreachable/);
  });
});

test('REPORT: a missing service shows up as false, so "why is it off?" is answerable', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const ctx = createCordisLikeContext({ services: { logger: { info() {}, warn() {} } } });
    assert.doesNotThrow(() => apply(ctx, { configPath: file, defineTool: DEFINE_TOOL }));
    const report = JSON.parse(readFileSync(startupReportPath(file), 'utf8'));
    assert.equal(report.services.tools, false);
    assert.equal(report.services.workflowEngine, false);
    assert.equal(report.enabled.deadlockDetector, true, 'asked for');
    assert.equal(report.services.workflowEngine, false, 'but the host had no engine');
  });
});

test('REPORT: failing to write it can never affect activation', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    // A FILE where the report directory must go: mkdirSync throws, and the
    // failure is swallowed by design.
    writeFileSync(join(dirname(file), 'state'), 'in the way', 'utf8');
    const host = createFakeHost();
    const byName = captureTools(host);
    let disposer;
    assert.doesNotThrow(() => {
      disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    });
    assert.ok(byName.has(TOOL_NAME), 'the tool still registered');
    assert.doesNotThrow(() => disposer());
  });
});

test('REPORT: startupReportPath tolerates junk input', () => {
  assert.equal(startupReportPath(undefined), join(dirname(DEFAULT_CONFIG_PATH), 'state', 'startup.json'));
  assert.equal(startupReportPath(''), join(dirname(DEFAULT_CONFIG_PATH), 'state', 'startup.json'));
  assert.equal(startupReportPath('C:/x/y/config.json'), join('C:/x/y', 'state', 'startup.json'));
});

// ─────────────────────────────────────────── cordis-shaped context (real trap)

/**
 *
 * `cordis/lib/index.js` ReflectService.handler.get: a property on the target
 * (methods such as `on`, and `get` itself) resolves normally, while a SERVICE
 * name the composition does not provide THROWS `cannot get property "x" without
 * inject`. `ctx.get(name)` is the sanctioned way to ask for a service without
 * declaring it in `inject`.
 *
 * This double exists because that trap caused two real boot failures: declaring
 * the service in `inject` makes a composition without it leave the plugin
 * `pending` (fatal for a non-workbench entry), and reading it directly throws
 * (equally fatal). Only `ctx.get` is safe, and only this double can prove it.
 */
function createCordisLikeContext({ services = {}, logger } = {}) {
  const all = logger === undefined ? services : { ...services, logger };
  const target = {
    get(prop) {
      return all[prop];
    },
    on() {
      return () => {};
    },
  };
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || Reflect.has(t, prop)) return Reflect.get(t, prop, receiver);
      throw new Error(`cannot get property "${String(prop)}" without inject`);
    },
  });
}

test('SAFETY: the cordis-like double really does reproduce the inject trap', () => {
  const ctx = createCordisLikeContext({ services: { tools: { register() {} } } });
  // If this ever stops throwing, the two tests below become vacuous.
  assert.throws(() => ctx.workflowEngine, /cannot get property "workflowEngine" without inject/);
  assert.throws(() => ctx.agents, /cannot get property "agents" without inject/);
  assert.equal(ctx.get('tools').register instanceof Function, true, 'get() is the safe path');
  assert.equal(ctx.get('workflowEngine'), undefined, 'get() returns undefined instead of throwing');
  assert.equal(typeof ctx.on, 'function', 'members on the target still resolve');
});

test('SAFETY: apply() never reads a service property directly (the real boot trap)', () => {
  // A context that provides ONLY the tools service, exactly like the web profile
  // provides `tools` but no `workflowEngine`. A single direct read of a missing
  // service would throw here and, in the host, stop DSH from booting.
  const registered = [];
  const services = {
    logger: { info() {}, warn() {} },
    tools: { register: (d) => registered.push(d) },
    defineTool: (d) => d,
  };
  withTempConfig(on({ contracts: true, templateLibrary: true, deadlockDetector: true }), (file) => {
    const ctx = createCordisLikeContext({ services });
    assert.doesNotThrow(() => apply(ctx, { configPath: file }), 'no direct service read is allowed');
    assert.deepEqual(registered.map((d) => d.name), [TOOL_NAME, LIBRARY_TOOL_NAME]);
  });
});

test('SAFETY: a cordis-like context that provides nothing at all still activates', () => {
  withTempConfig(on({ contracts: true, templateLibrary: true, deadlockDetector: true }), (file) => {
    const ctx = createCordisLikeContext({});
    assert.doesNotThrow(() => apply(ctx, { configPath: file }));
  });
});
test('SAFETY: inject is empty, so no missing service can make this plugin pending', () => {
  assert.equal(name, 'workflow-governance');
  // Every key of `inject` is a REQUIRED service in this cordis, and a pending
  // non-workbench entry is a FATAL startup error in dsh-app-boot. Listing a
  // service this profile may not provide is therefore how this plugin once
  // stopped DSH from booting. Keep this empty.
  assert.deepEqual([...inject], []);
});

test('SAFETY: apply() is TOTAL -- it cannot fail activation in any composition', () => {
  // The property that keeps DSH booting. A non-workbench entry that does not
  // activate throws StartupError in dsh-app-boot, so `apply()` must never throw
  // and must never depend on a service. Every feature is on here, and every host
  // facility is missing.
  const bare = { logger: { info() {}, warn() {} } };
  withTempConfig(on({ contracts: true, templateLibrary: true, deadlockDetector: true }), (file) => {
    assert.doesNotThrow(() => apply(bare, { configPath: file }));
    assert.doesNotThrow(() => apply({}, { configPath: file }));
    assert.doesNotThrow(() => apply(null, { configPath: file }));
    assert.doesNotThrow(() => apply(undefined, { configPath: file }));
  });
});

test('SAFETY: with nothing available it warns about each gap instead of throwing', () => {
  withTempConfig(on({ contracts: true, templateLibrary: true, deadlockDetector: true }), (file) => {
    const logs = { info: [], warn: [] };
    const ctx = { logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) } };
    apply(ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const all = logs.warn.join('\n');
    assert.match(all, /ctx\.tools\.register is unavailable/, 'tool registration gap is reported');
    // With no `on` there is no way to even wait for the engine, and that is the gap
    // that is reported -- checked before the engine, because it is checked first.
    assert.match(all, /ctx\.on is unavailable/, 'the observation gap is reported');
    // tools is missing for BOTH tool families, so two warnings come from there.
    assert.equal(logs.warn.length, 3, `exactly three warnings, got: ${all}`);
    assert.equal(logs.info.length, 1, 'the switch line is still logged');
  });
});

test('SAFETY: with no reachable defineTool the tools stay off, with a warning, and nothing throws', () => {
  withTempConfig(on({ contracts: true, templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    assert.doesNotThrow(() => apply(host.ctx, { configPath: file }));
    assert.equal(byName.size, 0, 'registering an unvalidated definition would be worse than no tool');
    const all = host.logs.warn.join('\n');
    assert.match(all, /the host's defineTool is unreachable; contract_workflow stays unregistered/);
    assert.match(all, /the host's defineTool is unreachable; contract_workflow_library stays unregistered/);
  });
});

test('SAFETY: a composition whose engine is isolated away still registers both tools AND observes', () => {
  // This is the real shape of the web profile: `tools` exists, `workflowEngine` is
  // isolated inside the `delegation` group so it is unreachable from here.
  withTempConfig(on({ contracts: true, templateLibrary: true, deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const byName = captureTools(host);
    host.ctx.workflowEngine = undefined; // unreachable, as shipped
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.ok(byName.has(TOOL_NAME), 'R7 tool is registered without an engine');
    assert.ok(byName.has(LIBRARY_TOOL_NAME), 'G1 tool is registered without an engine');
    // The six observe-only events are attached regardless: `attach()` is global and
    // never touches the engine, so an unreachable engine costs observation nothing.
    assert.equal(host.subscriptions.length, 6, 'observation is complete');
    assert.deepEqual(host.logs.warn, [], 'and there is nothing to warn about');
  });
});

test('resolveConfig never throws and degrades to all-off defaults', () => {
  const missing = resolveConfig(join(tmpdir(), 'definitely-absent', 'config.json'));
  assert.deepEqual(missing, defaultConfig());
  withTempConfig('{ not json', (file) => assert.deepEqual(resolveConfig(file), defaultConfig()));
  withTempConfig({ switches: { workflowMode: 'yes' } }, (file) => assert.deepEqual(resolveConfig(file), defaultConfig()));
  withTempConfig({ matcher: { askThreshold: 0.99, reuseThreshold: 0.1 } }, (file) => assert.deepEqual(resolveConfig(file), defaultConfig()));
});

test('resolveConfig honours a valid file', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    assert.equal(resolveConfig(file).switches.deadlockDetector, true);
  });
});

test('DEFAULT_CONFIG_PATH sits beside package.json, where a deployment config is expected', () => {
  // Structural only. A test that reads the real path would go red the moment an
  // operator configures the plugin -- which is normal use, not a defect.
  assert.equal(DEFAULT_CONFIG_PATH, join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'));
});

test('with no config file the plugin is INERT: no subscription, no timer, one log line', () => {
  const absent = join(tmpdir(), 'wfg-absent-config', 'config.json');
  assert.equal(existsSync(absent), false, 'the fixture path must really be absent');
  const host = createFakeHost({ withTimer: true });
  const disposer = apply(host.ctx, { configPath: absent });
  assert.equal(disposer, undefined, 'an inert plugin returns no disposer');
  assert.deepEqual(host.subscriptions, [], 'nothing subscribed');
  assert.equal(host.timers.length, 0, 'no timer armed');
  assert.equal(host.logs.info.length, 1);
  assert.match(host.logs.info[0], /"deadlockDetector":false/);
  assert.deepEqual(host.logs.warn, []);
});

test('turning on the detector subscribes the 6 events and arms one ctx-scoped timer', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(typeof disposer, 'function');
    assert.deepEqual(
      host.subscriptions.map((s) => s.name),
      ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'],
    );
    for (const s of host.subscriptions) assert.deepEqual(s.options, { global: true });
    assert.equal(host.timers.length, 1);
    assert.equal(host.timers[0].ms, 30_000);
  });
});

test('an unusable engine value does not stop observation, it only costs the control seam', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    host.ctx.workflowEngine = { notStart: true }; // present but not a real engine
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(typeof disposer, 'function', 'there is something to tear down');
    assert.equal(host.subscriptions.length, 6, 'observation still attached');
    assert.equal(readReport(file).detector, 'attached-observe-only');
    assert.deepEqual(host.logs.warn, [], 'a control-less engine is not a warning');
    assert.doesNotThrow(() => disposer());
  });
});

test('no ctx timer: the plugin falls back to the platform timer instead of giving up', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: false }); // ctx.setInterval absent
    const armed = [];
    const cleared = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    // Spy on the platform timer rather than arming a real interval.
    globalThis.setInterval = (fn, ms) => {
      const handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      armed.push(handle);
      return handle;
    };
    globalThis.clearInterval = (handle) => cleared.push(handle);
    let disposer;
    try {
      disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }

    assert.equal(armed.length, 1, 'the periodic scan is armed from the platform');
    assert.equal(armed[0].unrefCalled, true, 'and it is unref-ed so it cannot hold the process open');
    assert.deepEqual(host.logs.warn, [], 'this is not a warning: nothing is missing');
    assert.equal(readReport(file).timer, 'global');

    // Teardown must clear it, or a diagnostic outlives the plugin.
    globalThis.clearInterval = (handle) => cleared.push(handle);
    try {
      disposer();
    } finally {
      globalThis.clearInterval = realClear;
    }
    assert.equal(cleared.length, 1, 'the interval was cleared on teardown');
  });
});

test('no timer anywhere: it still observes, and says the escalation is off', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: false });
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    // Remove the platform fallback too, so nothing can scan.
    delete globalThis.setInterval;
    delete globalThis.clearInterval;
    let disposer;
    try {
      disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
    assert.equal(host.subscriptions.length, 6, 'event observation stays on');
    assert.equal(readReport(file).timer, 'none');
    assert.match(host.logs.warn.join('\n'), /no timer is available/);
    assert.equal(typeof disposer, 'function');
  });
});

test('a ctx without on() disables the detector instead of throwing', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    delete host.ctx.on;
    assert.equal(apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL }), undefined);
    assert.equal(host.logs.warn.length, 1);
  });
});

test('apply tolerates a null ctx and a non-object options argument', () => {
  assert.doesNotThrow(() => apply(null));
  assert.doesNotThrow(() => apply(undefined, 'nonsense'));
  const host = createFakeHost();
  assert.doesNotThrow(() => apply(host.ctx, 42));
});

test('a stall is escalated only after escalateAfter consecutive scans, then re-arms', () => {
  withTempConfig(on({ deadlockDetector: true, escalateAfter: 2, idleTimeoutMs: 1000 }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const clock = clockHost();
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });
    const scan = host.timers[0].fn;

    const run = host.engine.start(goodRequest());
    run.startAgent(1, { phase: 'collect' });
    // Silence from here on: the agent stays RUNNING with no further events.

    clock.advance(10_000);
    scan(); // first stalled observation -> streak 1, below threshold
    assert.equal(host.logs.warn.length, 0);

    scan(); // streak 2 -> escalate once
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /停滞/);

    scan(); // re-armed: needs another full streak
    assert.equal(host.logs.warn.length, 1);
    scan();
    assert.equal(host.logs.warn.length, 2);
  });
});

test('a settled run is never escalated', () => {
  withTempConfig(on({ deadlockDetector: true, escalateAfter: 1, idleTimeoutMs: 1 }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const clock = clockHost();
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });
    const scan = host.timers[0].fn;
    host.engine.start(goodRequest()).finish({ stopReason: 'completed' });
    clock.advance(10_000);
    scan();
    assert.deepEqual(host.logs.warn, []);
  });
});

test('SAFETY: the plugin is observe-only -- it never starts, cancels or disposes a run', () => {
  withTempConfig(on({ deadlockDetector: true, escalateAfter: 1, idleTimeoutMs: 1 }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const engineStartsBefore = host.engine.starts;
    const clock = clockHost();
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });
    const scan = host.timers[0].fn;

    const run = host.engine.start(goodRequest());
    run.startAgent(1, { phase: 'p' });
    clock.advance(10_000);
    scan();

    assert.equal(host.engine.starts, engineStartsBefore + 1, 'the only start was the test fixture, not the plugin');
    assert.equal(run.disposeCount, 0, 'the plugin never disposes a run');
    assert.equal(run.cancelled, null, 'the plugin never cancels a run');
    assert.equal(run.stopReason, null, 'the plugin never settles a run');
  });
});

test('SAFETY: a run another holder started is MONITORED but can never be controlled', () => {
  withTempConfig(on({ deadlockDetector: true, escalateAfter: 1, idleTimeoutMs: 1 }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const clock = clockHost();
    apply(host.ctx, { configPath: file, now: clock.now, defineTool: DEFINE_TOOL });
    const scan = host.timers[0].fn;

    // Start directly on the engine: the plugin has no handle and no ownership.
    const run = host.engine.start(goodRequest());
    run.startAgent(1, { phase: 'p' });

    clock.advance(10_000);
    scan();

    assert.equal(host.logs.warn.length, 1, 'a stalled run is reported regardless of who started it');
    assert.match(host.logs.warn[0], /停滞/);
    // The plugin owns no run, so it has no path to control one.
    assert.equal(run.disposeCount, 0, 'never disposed');
    assert.equal(run.cancelled, null, 'never cancelled');
    assert.equal(run.stopReason, null, 'never settled');
  });
});

test('the returned disposer clears the timer and unsubscribes', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(host.timers[0].cleared, false);
    disposer();
    assert.equal(host.timers[0].cleared, true);
    for (const s of host.subscriptions.map((x) => x.name)) assert.equal(host.ctx.listenerCount(s), 0);
  });
});

test('the timer handle is cleared through whichever shape this composition returns', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    // composition returns a function handle instead of an object
    const host = createFakeHost({ withTimer: true });
    let called = 0;
    host.ctx.setInterval = () => () => {
      called += 1;
    };
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    disposer();
    assert.equal(called, 1);

    // composition returns a disposable object
    const host2 = createFakeHost({ withTimer: true });
    let disposed = 0;
    host2.ctx.setInterval = () => ({ dispose: () => { disposed += 1; } });
    apply(host2.ctx, { configPath: file })();
    assert.equal(disposed, 1);
  });
});

// ------------------------------------------------------- R7: run_workflow tool

/** Fake ctx.tools that captures what was registered. */
function toolsOf() {
  const registered = [];
  return {
    registered,
    ctx: {
      register(definition) {
        registered.push(definition);
        return () => registered.pop();
      },
    },
  };
}

/** The calling-agent context a tool receives; the delegation request needs it. */
const PARENT_EXEC = { agent: { id: 'parent-agent' } };

/**
 * A host-shaped `subagents` service double.
 *
 * Built from the canonical caller `@deepseek-ai/dsh-tool-subagent`, so it enforces
 * what the real service enforces: `start(provider, request)` where the request
 * carries `label`, `prompt` content blocks and the calling `parent`, returning a
 * run that exposes `id`, `result` and `dispose`.
 */
const SUBAGENTS_OK = (table, options = {}) => {
  const started = [];
  const disposed = [];
  return {
    started,
    disposed,
    start: async (provider, request) => {
      started.push({ provider, request });
      assert.ok(request.parent, 'the delegation request must carry the calling agent');
      assert.equal(request.prompt[0].type, 'text', 'prompt is a content-block array');
      const text = request.prompt.map((block) => block.text).join('');
      const hit = Object.keys(table).find((key) => text.includes(`do ${key}`));
      assert.ok(hit, `no fixture matched prompt: ${text.slice(0, 80)}`);
      const value = table[hit];
      const answer = typeof value === 'string' ? value : JSON.stringify(value);
      return {
        id: `run-${hit}`,
        result: Promise.resolve({ stopReason: options.stopReason ?? 'completed', output: [{ type: 'text', text: answer }] }),
        dispose: async () => {
          disposed.push(hit);
        },
      };
    },
  };
};

test('R7 is OFF by default: no tool is registered and nothing is spawned', () => {
  withTempConfig(on({}), (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.deepEqual(tools.registered, []);
  });
});

test('the tool name is namespaced and never shadows a host tool name', () => {
  // A host tool called `run_workflow` exists in this deployment; the security
  // baseline forbids colliding with native capability, so this is a guard.
  assert.equal(TOOL_NAME, 'contract_workflow');
  assert.notEqual(TOOL_NAME, 'run_workflow');
});

test('R7 registers the namespaced tool with an OPEN, optional workflow parameter', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(tools.registered.length, 1);
    const def = tools.registered[0];
    assert.equal(def.name, TOOL_NAME);
    // Open and optional by design: the parameter DSL rejects `required` on an
    // `items` spec, and `name` is the alternative to `workflow`, so neither may
    // be required. The real check is this layer's own validator.
    assert.equal(def.parameters.workflow.type, 'object');
    assert.equal(def.parameters.workflow.additionalProperties, true);
    assert.equal(def.parameters.workflow.required, undefined);
    assert.equal(def.parameters.workflow.properties, undefined, 'no structural schema to drift from validateWorkflow');
    assert.equal(def.parameters.name.type, 'string');
    assert.equal(typeof def.execute, 'function');
    assert.equal(typeof def.output.render, 'function');
    assert.match(def.description, /contract/i);
  });
});

test('R7: a missing tools service warns instead of throwing', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.deepEqual(host.logs.warn.map((w) => /ctx\.tools\.register is unavailable/.test(w)), [true]);
  });
});

test('R7: the tool runs a contract-clean DAG end to end through ctx.subagents', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const subagents = SUBAGENTS_OK({ a: { text: 'hello' }, b: { text: 'hello world' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const def = tools.registered[0];
    const workflow = {
      nodes: [{ id: 'a', prompt: 'do a' }, { id: 'b', prompt: 'do b' }],
      edges: [{ from: 'a', to: 'b', when: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } }],
    };
    const result = await def.execute({ workflow }, PARENT_EXEC);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.outputs.b.text, 'hello world');
    // The delegation request matches the canonical caller's shape, the configured
    // provider is used, and every foreground run is released.
    assert.equal(subagents.started.length, 2, 'one run per node');
    assert.equal(subagents.started[0].provider, 'spawn', 'the configured provider name');
    assert.equal(subagents.started[0].request.parent, PARENT_EXEC.agent, 'the calling agent is the parent');
    assert.match(subagents.started[0].request.label, /workflow node a/);
    assert.deepEqual(subagents.disposed.sort(), ['a', 'b'], 'every run was disposed');
  });
});

test('R7: a subagent run that did not complete becomes NODE_FAILED naming the reason', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    host.ctx.subagents = SUBAGENTS_OK({ a: { text: 'x' } }, { stopReason: 'max-tokens' });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await tools.registered[0].execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, PARENT_EXEC);
    assert.equal(result.status, 'NODE_FAILED');
    assert.match(result.error, /max-tokens/);
  });
});

test('R7: without a calling agent the failure names exactly that', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    host.ctx.subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    // exec has no agent: a delegation request cannot be built.
    const result = await tools.registered[0].execute({ workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] } }, {});
    assert.equal(result.status, 'NODE_FAILED');
    assert.match(result.error, /needs a calling agent/);
  });
});

test('R7: without agents the tool reports NODE_FAILED with a diagnosable message', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    // no ctx.subagents at all: the delegation service is not loaded
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await tools.registered[0].execute({
      workflow: { nodes: [{ id: 'a', prompt: 'do a' }], edges: [] },
    }, PARENT_EXEC);
    assert.equal(result.status, 'NODE_FAILED');
    assert.match(result.error, /ctx\.subagents\.start is unavailable/);
  });
});

test('R7: a contract-violating agent output is re-run and then reported upstream', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    let n = 0;
    host.ctx.subagents = {
      start: async () => {
        n += 1;
        return {
          id: 'r',
          // always violates minLength, in the shape a subagent really returns
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ text: '' }) }] }),
          dispose: async () => {},
        };
      },
    };
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await tools.registered[0].execute({
      workflow: {
        nodes: [{ id: 'a', prompt: 'do a' }, { id: 'b', prompt: 'do b' }],
        edges: [{ from: 'a', to: 'b', when: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } } }],
      },
    }, PARENT_EXEC);
    assert.equal(result.status, 'OUTPUT_VIOLATES_CONTRACT');
    assert.equal(result.upstream, 'a');
    assert.equal(n, 2, 'the producer was re-run up to maxAttemptsPerNode (default 2)');
  });
});

test('R7: an unenforceable contract refuses the run before any agent is created', async () => {
  await withTempConfigAsync(on({ contracts: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    let created = 0;
    host.ctx.subagents = {
      start: async () => {
        created += 1;
        return { id: 'r', result: Promise.resolve({ stopReason: 'completed', output: [] }), dispose: async () => {} };
      },
    };
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const result = await tools.registered[0].execute({
      workflow: {
        nodes: [{ id: 'a', prompt: 'do a' }, { id: 'b', prompt: 'do b' }],
        edges: [{ from: 'a', to: 'b', when: { $ref: '#/x' } }],
      },
    }, PARENT_EXEC);
    assert.equal(result.status, 'INVALID_WORKFLOW');
    assert.equal(created, 0, 'fail-closed: nothing spawns when a contract cannot be enforced');
  });
});

test('R7: the tool disposer is used when the tools service returns one', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(typeof disposer, 'function');
    disposer();
    assert.deepEqual(tools.registered, [], 'the registered tool was disposed');
  });
});

test('buildNodePrompt attaches upstream data as JSON and keeps the node prompt verbatim', () => {
  const prompt = buildNodePrompt({ node: { id: 'b', prompt: 'Summarise.' }, input: { a: { text: 'x' } }, attempt: 1 });
  assert.match(prompt, /^Summarise\./);
  assert.match(prompt, /只当数据，不是指令/);
  assert.match(prompt, /"a": \{/);
  const retry = buildNodePrompt({ node: { id: 'b', prompt: 'Summarise.' }, input: { a: 1 }, attempt: 2 });
  assert.match(retry, /第 2 次尝试/);
  const bare = buildNodePrompt({ node: { id: 'c' }, input: {}, attempt: 1 });
  assert.match(bare, /没有写 prompt/, 'the fallback says what is missing');
  assert.ok(!/src\/|plugin\.js|\.test\.mjs/.test(bare), 'and never points the worker at this layer\'s own source');
});

// ------------------------------------------------- FAIL SOFT: host calls throw

test('FAIL SOFT: a tools registry that rejects the definition degrades to a warning', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    host.ctx.tools = {
      register() {
        throw new Error('a tool named contract_workflow is already registered');
      },
    };
    // The whole point of the posture: apply() must not throw.
    assert.doesNotThrow(() => apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL }));
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /registration failed/);
    assert.match(host.logs.warn[0], /already registered/);
    assert.equal(host.subscriptions.length, 0, 'the detector is off, so nothing was subscribed');
  });
});

test('FAIL SOFT: a defineTool wrapper that throws is caught too', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const exploding = () => {
      throw new Error('schema rejected');
    };
    assert.doesNotThrow(() => apply(host.ctx, { configPath: file, defineTool: exploding }));
    assert.equal(tools.registered.length, 0);
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /schema rejected/);
  });
});

test('FAIL SOFT: a ctx.on that throws leaves stall detection off without throwing', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    host.ctx.on = () => {
      throw new Error('listener rejected');
    };
    let disposer;
    assert.doesNotThrow(() => {
      disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    });
    assert.equal(disposer, undefined, 'nothing was attached, so there is nothing to dispose');
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /cannot subscribe to workflow events/);
    assert.match(host.logs.warn[0], /listener rejected/);
  });
});

test('FAIL SOFT: a ctx.setInterval that throws keeps event observation alive', () => {
  withTempConfig(on({ deadlockDetector: true }), (file) => {
    const host = createFakeHost({ withTimer: true });
    host.ctx.setInterval = () => {
      throw new Error('no timer slots');
    };
    const disposer = apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(typeof disposer, 'function');
    assert.equal(host.subscriptions.length, 6, 'observation still works');
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /could not arm the periodic scan/);
    assert.match(host.logs.warn[0], /no timer slots/);
    // and the disposer is still safe to call
    assert.doesNotThrow(() => disposer());
    for (const s of host.subscriptions.map((x) => x.name)) assert.equal(host.ctx.listenerCount(s), 0);
  });
});

test('messageOf tolerates a thrown value with no message and an unrenderable one', () => {
  withTempConfig(on({ contracts: true }), (file) => {
    for (const thrown of [{}, null, 42]) {
      const host = createFakeHost();
      host.ctx.tools = {
        register() {
          throw thrown;
        },
      };
      assert.doesNotThrow(() => apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL }));
      assert.equal(host.logs.warn.length, 1);
      assert.match(host.logs.warn[0], /registration failed/);
    }
  });
});

// ------------------------------- G1: saved-workflow library (R11/R12/R14/R15)

const CONTRACT = { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } }, additionalProperties: false };
const savedGraph = () => ({
  nodes: [{ id: 'collect', prompt: 'do collect' }, { id: 'synth', prompt: 'do synth' }],
  edges: [{ from: 'collect', to: 'synth', when: CONTRACT }],
});

/** Register into a fake ctx and return the captured definitions by name. */
function captureTools(host) {
  const byName = new Map();
  host.ctx.tools = {
    register(definition) {
      byName.set(definition.name, definition);
      return () => byName.delete(definition.name);
    },
  };
  return byName;
}

test('G1 is OFF by default: no library tool, and no library file is created', () => {
  withTempConfig(on({}), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    assert.equal(byName.size, 0);
    assert.equal(existsSync(join(dirname(file), 'library')), false, 'nothing is written unless a switch is on');
  });
});

test('G1 registers a namespaced library tool with the documented actions', () => {
  withTempConfig(on({ templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const def = byName.get(LIBRARY_TOOL_NAME);
    assert.ok(def, 'the library tool is registered');
    assert.equal(LIBRARY_TOOL_NAME, 'contract_workflow_library');
    assert.notEqual(LIBRARY_TOOL_NAME, TOOL_NAME);
    assert.equal(def.parameters.action.required, true);
    assert.match(def.description, /REFUSES/);
  });
});

test('G1: the library lives beside the config, not in the working directory', () => {
  withTempConfig(on({ templateLibrary: true }), (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const expected = join(dirname(file), 'library', 'library.json');
    assert.match(host.logs.info.join(' '), new RegExp(`root=${expected.replace(/\\/g, '\\\\')}`));
  });
});

test('G1: save / list / get / rename / remove work through the tool (R15)', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    const saved = await lib.execute({ action: 'save', definition: { name: 'investigate', labels: ['research'], ...savedGraph() } });
    assert.equal(saved.ok, true);
    assert.equal(saved.entry.revision, 1);

    const listed = await lib.execute({ action: 'list' });
    assert.deepEqual(listed.entries.map((e) => e.name), ['investigate']);

    const got = await lib.execute({ action: 'get', name: 'investigate' });
    assert.equal(got.entry.nodes.length, 2);
    assert.equal(await lib.execute({ action: 'get', name: 'ghost' }).then((r) => r.entry), null);

    assert.equal((await lib.execute({ action: 'rename', name: 'investigate', newName: 'investigate-v2' })).code, 'RENAMED');
    assert.deepEqual((await lib.execute({ action: 'list' })).entries.map((e) => e.name), ['investigate-v2']);

    assert.equal((await lib.execute({ action: 'remove', name: 'investigate-v2' })).code, 'REMOVED');
    assert.deepEqual((await lib.execute({ action: 'list' })).entries, []);
  });
});

test('G1: the tool REFUSES an unenforceable or broken graph (fail-closed)', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    const bad = await lib.execute({ action: 'save', definition: { name: 'bad', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] } });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_WORKFLOW');
    assert.deepEqual((await lib.execute({ action: 'list' })).entries, []);

    const unknown = await lib.execute({ action: 'nonsense' });
    assert.equal(unknown.code, 'UNKNOWN_ACTION');
  });
});

test('G1: an unknown action and a bad import never throw out of the tool', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    assert.equal((await lib.execute({ action: 'import', json: '{ nope' })).code, 'INVALID_JSON');
    assert.doesNotThrow(() => lib.execute({}));
  });
});

test('R14: contract_workflow runs a SAVED workflow by name and feeds its history', async () => {
  await withTempConfigAsync(on({ contracts: true, templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    host.ctx.subagents = SUBAGENTS_OK({ collect: { text: 'seed' }, synth: { text: 'done' } });
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);

    assert.equal((await lib.execute({ action: 'save', definition: { name: 'flow-a', ...savedGraph() } })).ok, true);

    const run = await byName.get(TOOL_NAME).execute({ name: 'flow-a' }, PARENT_EXEC);
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.outputs.synth.text, 'done');

    const [row] = (await lib.execute({ action: 'list' })).entries;
    // A successful named run is recorded, and so is its automatic score: this graph ran
    // with no retry and no violation, which is a perfect 1.
    assert.deepEqual(row.stats, { runs: 1, successes: 1, scoreSum: 1, scoredRuns: 1 }, 'a successful named run is recorded, with its score');
  });
});

test('R14: a failing named run records a failure, and a missing name never spawns', async () => {
  await withTempConfigAsync(on({ contracts: true, templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    let created = 0;
    host.ctx.subagents = {
      start: async () => {
        created += 1;
        return {
          id: 'r',
          // violates minLength, in the shape a subagent really returns
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify({ text: '' }) }] }),
          dispose: async () => {},
        };
      },
    };
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    await lib.execute({ action: 'save', definition: { name: 'flow-a', ...savedGraph() } });

    const failed = await byName.get(TOOL_NAME).execute({ name: 'flow-a' }, PARENT_EXEC);
    assert.equal(failed.status, 'OUTPUT_VIOLATES_CONTRACT');
    assert.equal((await lib.execute({ action: 'list' })).entries[0].stats.successes, 0);
    assert.ok(created > 0);

    const before = created;
    const missing = await byName.get(TOOL_NAME).execute({ name: 'no-such-flow' }, PARENT_EXEC);
    assert.equal(missing.status, 'NOT_FOUND');
    assert.equal(created, before, 'a missing name must not spawn anything');
  });
});

test('R12: the library tool can pick a workflow for a task', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    await lib.execute({
      action: 'save',
      definition: { name: '并行调查', description: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'], ...savedGraph() },
    });
    const hit = await lib.execute({ action: 'find', query: { name: '并行调查', text: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'] } });
    assert.equal(hit.decision, 'reuse');
    assert.equal(hit.best.id, '并行调查');
    const miss = await lib.execute({ action: 'find', query: { name: '无关主题', labels: ['cooking'] } });
    assert.equal(miss.decision, 'create');
  });
});

test('FAIL SOFT: a library tool registration that throws degrades to a warning', () => {
  withTempConfig(on({ templateLibrary: true }), (file) => {
    const host = createFakeHost();
    host.ctx.tools = {
      register() {
        throw new Error('registry full');
      },
    };
    assert.doesNotThrow(() => apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL }));
    assert.equal(host.logs.warn.length, 1);
    assert.match(host.logs.warn[0], /contract_workflow_library registration failed/);
  });
});

test('G1: a corrupt library file surfaces as a rejection instead of wiping the operator data', async () => {
  await withTempConfigAsync(on({ templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const byName = captureTools(host);
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = byName.get(LIBRARY_TOOL_NAME);
    const root = join(dirname(file), 'library');
    mkdirSync(root, { recursive: true });
    const libFile = join(root, 'library.json');
    writeFileSync(libFile, '{ truncated', 'utf8');
    // execute() is async, so the failure arrives as a rejected promise; the
    // point is that it does NOT resolve to an empty list.
    await assert.rejects(() => lib.execute({ action: 'list' }), /not valid JSON/);
    assert.equal(readFileSync(libFile, 'utf8'), '{ truncated', 'the bytes are left alone');
  });
});

test('scoreRunReport grades a run automatically, from the run itself', () => {
  // Nobody rates a run by hand: a rerun a contract forced, or a node sent back upstream,
  // is visible in the node results, and that is what "did this graph run well" means.
  assert.equal(scoreRunReport({ status: 'COMPLETED', nodes: { a: { status: 'DONE', attempts: 1 }, b: { status: 'DONE', attempts: 1 } } }), 1);
  assert.equal(scoreRunReport({ status: 'COMPLETED', nodes: { a: { status: 'DONE', attempts: 2 }, b: { status: 'DONE', attempts: 1 } } }), 0.85);
  assert.equal(scoreRunReport({ status: 'CONTRACT_VIOLATION', nodes: { a: { status: 'CONTRACT_VIOLATION', attempts: 2 } } }), 0);
  // Clamped, never negative, and safe on shapes it has not seen (an array of rows).
  assert.equal(scoreRunReport({ status: 'COMPLETED', nodes: [{ status: 'CONTRACT_VIOLATION', attempts: 3 }], violations: [1, 2] }), 0);
  assert.equal(scoreRunReport(undefined), 0.4);
});
// ─────────────────────── the isolation rule: a node may not nest a workflow (step 10)

test('a node worker may not start another workflow, while its session still may', async () => {
  // The marker is the HOST's, never a guess: a spawned worker's session header carries
  // `origin: 'subagent'` (or a `parentSession`). Only a positive marker refuses, so an
  // unreachable header degrades to "not a worker" -- wrongly refusing a real session
  // would be far worse than failing to catch a nested run.
  assert.equal(isWorkflowWorker(undefined), false, 'no marker, no refusal');
  assert.equal(isWorkflowWorker({ agent: { id: 'a' } }), false);
  assert.equal(isWorkflowWorker({ agent: { id: 'a', session: { header: { origin: 'subagent' } } } }), true);
  assert.equal(isWorkflowWorker({ agent: { id: 'a', header: { parentSession: 'session-1' } } }), true);

  await withTempConfigAsync(on({ contracts: true, templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    const subagents = SUBAGENTS_OK({ a: { text: 'x' } });
    host.ctx.subagents = subagents;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });

    const worker = { ...PARENT_EXEC, agent: { ...PARENT_EXEC.agent, session: { header: { origin: 'subagent' } } } };
    const refused = await tools.registered[0].execute(
      { workflow: { nodes: [{ id: 'a', label: 'A', prompt: 'x' }], edges: [] } },
      worker,
    );
    assert.equal(refused.status, 'NESTED_WORKFLOW_REFUSED');
    assert.equal(subagents.started.length, 0, 'a refused nested run must spawn nothing');

    const libraryTool = tools.registered.find((tool) => tool.name === LIBRARY_TOOL_NAME);
    assert.ok(libraryTool, 'the library tool is registered');
    const listed = await libraryTool.execute({ action: 'list' }, worker);
    assert.equal(listed.ok, true, 'reading the library inside a worker is harmless and stays allowed');
    const saved = await libraryTool.execute(
      { action: 'save', definition: { name: 'from-a-worker', nodes: [{ id: 'a', label: 'A', prompt: 'x' }], edges: [] } },
      worker,
    );
    assert.equal(saved.status, 'NESTED_WORKFLOW_REFUSED', 'a worker may not write to the shared library');
  });
});

test('a text query that equals a saved name reuses it, and an unknown query key is refused', async () => {
  // Measured live: the SAME words scored 1.0000 as `{name}` and 0.0000 as `{text}`, and a
  // query written as `{ task: ... }` was silently ignored so every score came back zero.
  const { selectTemplate } = await import('../src/matcher.js');
  const picked = selectTemplate({ text: '整理周报' }, [{ id: '整理周报', name: '整理周报', stats: { runs: 1, successes: 1 } }]);
  assert.equal(picked.decision, 'reuse', 'a text query equal to a name is a name lookup');
  assert.equal(picked.best.score, 1);

  assert.deepEqual(normalizeQuery({ task: 'x' }).query, { text: 'x' }, 'task is an alias of text');
  assert.deepEqual(normalizeQuery(undefined), { query: null, problems: [] });
  assert.equal(normalizeQuery({ typo: 1 }).problems.length, 1, 'an unknown key is reported, never dropped');
  assert.deepEqual(normalizeQuery({ name: 'a', labels: ['l'] }).query, { name: 'a', labels: ['l'] });

  await withTempConfigAsync(on({ contracts: true, templateLibrary: true }), async (file) => {
    const host = createFakeHost();
    const tools = toolsOf();
    host.ctx.tools = tools.ctx;
    apply(host.ctx, { configPath: file, defineTool: DEFINE_TOOL });
    const lib = tools.registered.find((t) => t.name === LIBRARY_TOOL_NAME);
    const bad = await lib.execute({ action: 'find', query: { typo: 1 } });
    assert.equal(bad.code, 'BAD_QUERY', 'a bad query is refused instead of scoring nothing');
    assert.match(bad.message, /unknown query key/);
    const good = await lib.execute({ action: 'find', query: { task: 'anything' } });
    // `find` answers with a SCORED decision, not an `ok` envelope: what matters here is
    // that a `task` query produced a real decision instead of an empty one.
    assert.ok(['reuse', 'ask', 'create'].includes(good.decision), 'task is accepted, so a real query is never silently empty');
  });
});
