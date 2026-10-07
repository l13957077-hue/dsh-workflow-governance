import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  escapeLabel,
  labelForNode,
  describeContract,
  edgeProvenance,
  isInferredEdge,
  graphEndpoints,
  toMermaid,
  toMermaidFence,
  describeGraph,
} from '../src/diagram.js';

// ─────────────────────────── R4: declared edges vs edges only inferred

test('R4: edgeProvenance separates what the workflow states from what was guessed', () => {
  assert.deepEqual(edgeProvenance(graph()), { declared: 1, inferred: 0, total: 1 });
  assert.deepEqual(
    edgeProvenance({ nodes: [], edges: [{ from: 'a', to: 'b', when: { type: 'object' } }, { from: 'b', to: 'c', inferred: 'phase-order' }] }),
    { declared: 1, inferred: 1, total: 2 },
  );
  // No contract and no provenance is NOT a fact, so it counts as inferred.
  assert.deepEqual(edgeProvenance({ nodes: [], edges: [{ from: 'a', to: 'b' }] }), { declared: 0, inferred: 1, total: 1 });
  assert.deepEqual(edgeProvenance(undefined), { declared: 0, inferred: 0, total: 0 });
  assert.deepEqual(edgeProvenance({ edges: 'nonsense' }), { declared: 0, inferred: 0, total: 0 });
});

test('R4: an inferred edge is drawn dashed and labelled as inferred', () => {
  const out = toMermaid({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { from: 'a', to: 'b', when: CONTRACT },
      { from: 'b', to: 'c', inferred: 'phase-order' },
    ],
  });
  assert.match(out, /n0 -->\|"required text/, 'a declared edge keeps the solid arrow and its contract');
  assert.match(out, /n1 -\.->\|"inferred: phase-order"\| n2/, 'a guess is dashed and says so');
  // A contract-less edge is a guess too, and must not look like a declaration.
  const bare = toMermaid({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] });
  assert.match(bare, /-\.->\|"inferred: not declared"\|/);
  assert.ok(!/ --> /.test(bare), 'no solid arrow for an unproven edge');
});

test('R4: describeGraph discloses inference only when there is a guess to disclose', () => {
  assert.equal(describeGraph(graph()), '2 node(s), 1 edge(s) · start collect · end synth', 'a declared graph stays plain');
  assert.equal(
    describeGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', inferred: 'phase-order' }] }),
    '2 node(s), 1 edge(s) (1 inferred, not declared) · start a · end b',
  );
});

test('R4: isInferredEdge treats anything unproven as a guess', () => {
  assert.equal(isInferredEdge({ from: 'a', to: 'b', when: CONTRACT }), false);
  assert.equal(isInferredEdge({ from: 'a', to: 'b', inferred: 'phase-order', when: CONTRACT }), true, 'an explicit mark wins');
  assert.equal(isInferredEdge({ from: 'a', to: 'b' }), true);
  assert.equal(isInferredEdge(null), true);
  assert.equal(isInferredEdge('nonsense'), true);
});

const CONTRACT = {
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};
const graph = () => ({
  nodes: [
    { id: 'collect', prompt: 'collect the points' },
    { id: 'synth', prompt: 'summarise the points' },
  ],
  edges: [{ from: 'collect', to: 'synth', when: CONTRACT }],
});

// ─────────────────────────────────────────────────────────────── escaping

test('escapeLabel neutralises what Mermaid cannot escape', () => {
  assert.equal(escapeLabel('plain'), 'plain');
  assert.equal(escapeLabel('say "hi"'), "say 'hi'");
  // Brackets, braces and the pipe break a quoted label; parentheses do not, and
  // they carry meaning in a contract summary.
  assert.equal(escapeLabel('a[b]c{d}e|f<g>'), 'a b c d e f g');
  assert.equal(escapeLabel('text:string(min1)'), 'text:string(min1)');
  assert.equal(escapeLabel('line1\nline2'), 'line1<br/>line2');
  assert.equal(escapeLabel('too   many    spaces'), 'too many spaces');
  assert.equal(escapeLabel('  padded  '), 'padded');
});

test('escapeLabel is total and bounded', () => {
  assert.equal(escapeLabel(undefined), '');
  assert.equal(escapeLabel(null), '');
  assert.equal(escapeLabel(42), '42');
  assert.ok(escapeLabel('x'.repeat(500)).length <= 160, 'long labels are clipped');
  assert.match(escapeLabel('x'.repeat(500)), /\.\.\.$/);
});

// ─────────────────────────────────────────────────────────── node labels

test('labelForNode carries the id and a one-line prompt, unescaped', () => {
  // Raw with a real newline: escaping happens once, in escapeLabel.
  assert.equal(labelForNode({ id: 'a', prompt: 'do a' }), 'a\ndo a');
  assert.equal(labelForNode({ id: 'a' }), 'a');
  assert.equal(labelForNode({ id: 'a', prompt: '   ' }), 'a');
  assert.equal(labelForNode({ id: 'a', prompt: 'one\ntwo' }), 'a\none two');
  assert.equal(labelForNode({}), '?');
  assert.equal(labelForNode(null), '?');
});

test('labelForNode clips a long prompt instead of flooding the node', () => {
  const label = labelForNode({ id: 'a', prompt: 'y'.repeat(200) });
  assert.ok(label.length < 80, `label too long: ${String(label.length)}`);
  assert.match(label, /\.\.\.$/);
});

// ─────────────────────────────────────────────────────── edge contracts

test('describeContract summarises the keywords a reader needs', () => {
  assert.equal(describeContract(CONTRACT), 'required text; object; props text:string(min1); closed');
  assert.equal(describeContract({ type: 'object', properties: { a: { type: 'string' }, b: {} } }), 'object; props a:string b:any');
  assert.equal(describeContract({ type: 'array', minItems: 2 }), 'array; minItems 2');
  assert.equal(describeContract({ type: 'string', minLength: 3 }), 'string; minLength 3');
  assert.equal(describeContract({ type: 'object', properties: { s: { type: 'string', enum: ['a', 'b'] } } }), 'object; props s:string(enum2)');
  // No `<` or `>` anywhere: a label must survive the escaping pass unchanged.
  const label = describeContract(CONTRACT);
  assert.ok(!/[<>]/.test(label), 'labels must not contain angle brackets');
});

test('describeContract is total', () => {
  assert.equal(describeContract(undefined), '');
  assert.equal(describeContract(null), '');
  assert.equal(describeContract('nonsense'), '');
  assert.equal(describeContract([]), '');
  assert.equal(describeContract({}), '');
  assert.equal(describeContract({ required: 'not-an-array' }), '');
});

// ───────────────────────────────────────────────────────────── endpoints

test('graphEndpoints finds the entry and exit nodes', () => {
  assert.deepEqual(graphEndpoints(graph()), { sources: ['collect'], sinks: ['synth'] });
  assert.deepEqual(graphEndpoints({ nodes: [{ id: 'only' }], edges: [] }), { sources: ['only'], sinks: ['only'] });
  assert.deepEqual(graphEndpoints({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [{ from: 'a', to: 'c' }] }), { sources: ['a', 'b'], sinks: ['b', 'c'] });
  assert.deepEqual(graphEndpoints(undefined), { sources: [], sinks: [] });
  assert.deepEqual(graphEndpoints({ nodes: 'nonsense' }), { sources: [], sinks: [] });
});

// ────────────────────────────────── renderer detection (the block must be seen)

/**
 * What a Mermaid renderer needs before it will draw anything.
 *
 * `dsh-mermaid`'s heuristic, read out of its client bundle:
 *   const fence = /^language-(?:mermaid|mermaidjs|mmd)$/i
 *   const firstWord = /^\s*([A-Za-z][\w-]*)/
 *   const keywords = new Set(["flowchart", "graph", "sequenceDiagram", ...])
 * A block is drawn only when the fence language matches AND the FIRST identifier
 * of the body is a known diagram keyword. `%%` is a comment, so a leading title
 * comment silently makes the fence undetectable: source forever, and no error.
 */
const DETECTABLE_KEYWORDS = new Set([
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'stateDiagram', 'stateDiagram-v2',
  'erDiagram', 'gantt', 'pie', 'journey', 'timeline', 'mindmap', 'gitGraph',
]);

test('DETECTION: the first identifier of the body is a diagram keyword', () => {
  const bodies = [
    toMermaid(graph()),
    toMermaid(graph(), { direction: 'LR' }),
    toMermaid(graph(), { title: 'demo flow' }),
    toMermaid(graph(), { direction: 'LR', title: '演示 流程' }),
    toMermaid({ nodes: [], edges: [] }, { title: 'empty' }),
  ];
  for (const body of bodies) {
    const first = /^\s*([A-Za-z][\w-]*)/.exec(body);
    assert.ok(first, `no identifier found in:\n${body}`);
    assert.ok(
      DETECTABLE_KEYWORDS.has(first[1]),
      `a renderer would not detect this: first identifier is ${JSON.stringify(first[1])} in:\n${body}`,
    );
  }
});

test('DETECTION: a title comment never precedes the declaration', () => {
  const out = toMermaid(graph(), { title: 'demo' });
  assert.equal(out.split('\n')[0], 'flowchart TD', 'the declaration is line 1');
  assert.match(out, /%% demo/, 'the title is still emitted, just not first');
  assert.ok(!out.startsWith('%%'), 'a leading comment defeats renderer detection');
});

test('DETECTION: the fence language is one a renderer accepts', () => {
  const fenced = toMermaidFence(graph(), { title: 'demo' });
  assert.match(fenced, /^```mermaid\n/, 'fence language must be exactly `mermaid`');
  const body = fenced.replace(/^```mermaid\n/, '').replace(/\n```$/, '');
  assert.equal(/^\s*([A-Za-z][\w-]*)/.exec(body)[1], 'flowchart');
});

test('DETERMINISM: the same graph renders byte-identical every time', () => {
  // These functions hold no state, read no clock and use no randomness, so a
  // snapshot, a diff or a cache key over their output is safe. An observed change
  // in output therefore means the CODE changed, not that rendering is flaky --
  // which is exactly how the leading-comment bug was caught.
  const options = { direction: 'LR', title: 'demo' };
  const first = toMermaidFence(graph(), options);
  for (let i = 0; i < 25; i += 1) {
    assert.equal(toMermaidFence(graph(), options), first, `run ${String(i)} differed`);
  }
  const digest = createHash('sha256').update(first).digest('hex');
  assert.equal(digest, createHash('sha256').update(toMermaidFence(graph(), options)).digest('hex'));
  assert.match(first, /^```mermaid\nflowchart LR\n {2}%% demo\n/u, 'the declaration precedes the title comment');
});

// ────────────────────────────────────────────────────────────── rendering

test('toMermaid draws the declared graph with the contract on the edge', () => {
  const out = toMermaid(graph());
  const lines = out.split('\n');
  assert.equal(lines[0], 'flowchart TD');
  assert.equal(lines[1], '  n0["collect<br/>collect the points"]');
  assert.equal(lines[2], '  n1["synth<br/>summarise the points"]');
  assert.equal(lines[3], '  n0 -->|"required text; object; props text:string(min1); closed"| n1');
});

test('toMermaid honours direction and an optional title comment', () => {
  assert.match(toMermaid(graph(), { direction: 'LR' }), /^flowchart LR$/m);
  assert.match(toMermaid(graph(), { direction: 'nonsense' }), /^flowchart TD$/m, 'an unknown direction falls back');
  assert.match(toMermaid(graph(), { title: 'demo flow' }), /^\s*%% demo flow$/m);
});

test('toMermaid edits the edge style by provenance, not by accident', () => {
  // A contract-less edge used to be drawn as a plain solid arrow, which made an
  // unproven relationship look declared. R4 changed that deliberately.
  const bare = toMermaid({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] });
  assert.match(bare, /n0 -\.->\|"inferred: not declared"\| n1/);
  assert.ok(!bare.includes(' --> '), 'no unlabelled solid arrow is emitted');
  // A declared edge keeps the solid arrow plus its contract label.
  const declared = toMermaid({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', when: { type: 'object' } }] });
  assert.match(declared, /n0 -->\|"object"\| n1/);
});

test('toMermaid survives an empty, broken or dangling graph', () => {
  assert.match(toMermaid(undefined), /no nodes declared/);
  assert.match(toMermaid({ nodes: [], edges: [] }), /no nodes declared/);
  // A dangling edge is skipped rather than inventing a node for it.
  const dangling = toMermaid({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] });
  assert.ok(!dangling.includes('ghost'), 'a dangling edge must not appear as a node');
  assert.match(dangling, /n0\["a"\]/);
  // A malformed node still renders something rather than throwing.
  assert.doesNotThrow(() => toMermaid({ nodes: [null, { id: 'b' }], edges: [] }));
  assert.match(toMermaid({ nodes: [null], edges: [] }), /n0\["\?"\]/);
});

test('toMermaid keeps declared ids out of the Mermaid id namespace', () => {
  // Ids may collide with Mermaid syntax; the emitted ids are positional.
  const out = toMermaid({ nodes: [{ id: 'end' }, { id: 'subgraph' }], edges: [{ from: 'subgraph', to: 'end' }] });
  assert.match(out, /n0\["end"\]/);
  assert.match(out, /n1\["subgraph"\]/);
  assert.match(out, /n1 -\.->\|"[^"]*"\| n0/, 'the arrow connects them, drawn by provenance');
});

test('toMermaid never throws and never emits a raw quote', () => {
  const hostile = {
    nodes: [{ id: 'a"b', prompt: 'x" y' }, { id: 'b' }],
    edges: [{ from: 'a"b', to: 'b', when: { required: ['q"'] } }],
  };
  const out = toMermaid(hostile);
  assert.doesNotThrow(() => toMermaid(hostile));
  const labels = out.split('\n').filter((l) => l.includes('--') || l.includes('["'));
  for (const line of labels) {
    const quotes = (line.match(/"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes in: ${line}`);
  }
  assert.match(out, /required q'/);
});

test('toMermaidFence wraps the source for a Mermaid-aware viewer', () => {
  const fenced = toMermaidFence(graph());
  assert.match(fenced, /^```mermaid\nflowchart TD\n/);
  assert.match(fenced, /\n```$/);
});

test('describeGraph states the shape in one line', () => {
  assert.equal(describeGraph(graph()), '2 node(s), 1 edge(s) · start collect · end synth');
  assert.equal(describeGraph({ nodes: [], edges: [] }), '0 node(s), 0 edge(s) · start - · end -');
  assert.equal(describeGraph(undefined), '0 node(s), 0 edge(s) · start - · end -');
});

test('the diagram of a real saved definition is stable and readable end to end', () => {
  const saved = {
    nodes: [
      { id: 'collect', prompt: '收集要点' },
      { id: 'synth', prompt: '汇总要点' },
      { id: 'verify', prompt: '校验结论' },
    ],
    edges: [
      { from: 'collect', to: 'synth', when: CONTRACT },
      { from: 'synth', to: 'verify', when: { type: 'object', required: ['text', 'sources'], properties: { text: { type: 'string' }, sources: { type: 'array' } }, additionalProperties: false } },
    ],
  };
  const out = toMermaid(saved, { direction: 'LR', title: 'demo' });
  assert.match(out, /^\s*%% demo$/m);
  assert.match(out, /^flowchart LR$/m);
  assert.match(out, /collect<br\/>收集要点/);
  assert.match(out, /required text; object; props text:string\(min1\); closed/);
  assert.match(out, /required text,sources; object; props text:string sources:array; closed/);
  assert.equal(out.split('\n').filter((l) => l.includes('-->')).length, 2, 'one arrow per edge');
});
