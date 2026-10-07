import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkContractSupport,
  validateValue,
  validateContract,
  validateWorkflow,
  ENFORCED_KEYWORDS,
} from '../src/contract.js';

const okOn = (value, schema) => {
  const r = validateContract(value, schema);
  assert.equal(r.unsupported, false, `unexpected unsupported: ${JSON.stringify(r.problems)}`);
  assert.equal(r.ok, true, `expected pass, got ${JSON.stringify(r.errors)}`);
};
const badOn = (value, schema, keyword) => {
  const r = validateContract(value, schema);
  assert.equal(r.unsupported, false);
  assert.equal(r.ok, false, 'expected a violation');
  if (keyword) assert.ok(r.errors.some((e) => e.keyword === keyword), `expected keyword ${keyword}, got ${JSON.stringify(r.errors)}`);
  return r;
};

// ---------------------------------------------------------------- fail-closed

test('an unsupported keyword is a REFUSAL, never an ignored constraint', () => {
  for (const keyword of ['$ref', 'patternProperties', 'if', 'then', 'else', 'propertyNames', 'dependentRequired', 'contains', 'format', 'unevaluatedProperties']) {
    const schema = { type: 'object', [keyword]: keyword === 'if' ? { type: 'string' } : {} };
    const support = checkContractSupport(schema);
    assert.equal(support.ok, false, `${keyword} must be refused`);
    assert.ok(support.problems.some((p) => p.keyword === keyword));
  }
});

test('validateContract refuses instead of passing when the contract is unsupported', () => {
  const r = validateContract({ anything: 1 }, { type: 'object', $ref: '#/x' });
  assert.equal(r.ok, false);
  assert.equal(r.unsupported, true);
  assert.deepEqual(r.errors, [], 'a refusal is not a value violation');
  assert.ok(r.problems.length > 0);
});

test('annotation-only keywords are accepted and ignored', () => {
  const support = checkContractSupport({ type: 'string', title: 't', description: 'd', examples: ['a'], $comment: 'c', default: 'x' });
  assert.deepEqual(support.problems, []);
  okOn('hello', { type: 'string', title: 't', default: 'x' });
});

test('boolean schemas are supported', () => {
  assert.equal(checkContractSupport(true).ok, true);
  assert.equal(checkContractSupport(false).ok, true);
  okOn(1, true);
  badOn(1, false, 'false');
});

test('malformed schemas are reported, not silently treated as empty', () => {
  assert.equal(checkContractSupport('nope').ok, false);
  assert.equal(checkContractSupport({ type: 'wat' }).ok, false);
  assert.equal(checkContractSupport({ pattern: '(' }).ok, false);
  assert.equal(checkContractSupport({ pattern: 5 }).ok, false);
  assert.equal(checkContractSupport({ required: 'x' }).ok, false);
  assert.equal(checkContractSupport({ enum: [] }).ok, false);
  assert.equal(checkContractSupport({ allOf: [] }).ok, false);
  assert.equal(checkContractSupport({ properties: [] }).ok, false);
  assert.equal(checkContractSupport({ exclusiveMinimum: true }).ok, false, 'draft-04 boolean form must be refused');
  assert.equal(checkContractSupport({ minLength: 'x' }).ok, false);
  assert.ok(ENFORCED_KEYWORDS.includes('required'));
});

test('support problems carry a path so the contract can be located', () => {
  const { problems } = checkContractSupport({ properties: { a: { $ref: 'x' } } });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, '#/properties/a');
});

// ------------------------------------------------------------------- type/enum

test('type accepts a single name and a union', () => {
  okOn('s', { type: 'string' });
  okOn(5, { type: 'number' });
  okOn(5, { type: 'integer' });
  badOn(5.5, { type: 'integer' }, 'type');
  badOn(null, { type: 'object' }, 'type');
  badOn('s', { type: ['number', 'boolean'] }, 'type');
  okOn(true, { type: ['number', 'boolean'] });
});

test('const and enum use structural equality', () => {
  okOn({ a: [1, 2] }, { const: { a: [1, 2] } });
  badOn({ a: [1, 3] }, { const: { a: [1, 2] } }, 'const');
  okOn('b', { enum: ['a', 'b'] });
  badOn('c', { enum: ['a', 'b'] }, 'enum');
});

test('allOf / anyOf / oneOf / not', () => {
  okOn(5, { allOf: [{ type: 'integer' }, { minimum: 1 }] });
  badOn(0, { allOf: [{ type: 'integer' }, { minimum: 1 }] }, 'minimum');
  okOn('x', { anyOf: [{ type: 'number' }, { type: 'string' }] });
  badOn([], { anyOf: [{ type: 'number' }, { type: 'string' }] }, 'anyOf');
  okOn('x', { oneOf: [{ type: 'number' }, { type: 'string' }] });
  badOn(5, { oneOf: [{ type: 'number' }, { type: 'integer' }] }, 'oneOf');
  okOn('x', { not: { type: 'number' } });
  badOn(5, { not: { type: 'number' } }, 'not');
});

// -------------------------------------------------------------------- strings

test('string bounds and pattern', () => {
  okOn('abc', { type: 'string', minLength: 3, maxLength: 3 });
  badOn('ab', { minLength: 3 }, 'minLength');
  badOn('abcd', { maxLength: 3 }, 'maxLength');
  okOn('2026-01-01', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
  badOn('01/01/2026', { pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, 'pattern');
});

// -------------------------------------------------------------------- numbers

test('numeric bounds, exclusivity and multipleOf', () => {
  okOn(5, { minimum: 5, maximum: 5 });
  badOn(4, { minimum: 5 }, 'minimum');
  badOn(6, { maximum: 5 }, 'maximum');
  badOn(5, { exclusiveMinimum: 5 }, 'exclusiveMinimum');
  badOn(5, { exclusiveMaximum: 5 }, 'exclusiveMaximum');
  okOn(10, { multipleOf: 5 });
  badOn(7, { multipleOf: 5 }, 'multipleOf');
});

// --------------------------------------------------------------------- arrays

test('array bounds, uniqueness and items', () => {
  okOn([1, 2], { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' } });
  badOn([1], { minItems: 2 }, 'minItems');
  badOn([1, 2, 3], { maxItems: 2 }, 'maxItems');
  badOn([1, 2, 1], { uniqueItems: true }, 'uniqueItems');
  const r = badOn([1, 'x'], { items: { type: 'integer' } }, 'type');
  assert.equal(r.errors[0].path, '#/1', 'the item path must be reported');
});

test('a tuple items array validates positionally', () => {
  okOn([1, 'a'], { items: [{ type: 'integer' }, { type: 'string' }] });
  badOn(['a', 'a'], { items: [{ type: 'integer' }, { type: 'string' }] }, 'type');
});

// -------------------------------------------------------------------- objects

test('required, properties and additionalProperties:false', () => {
  const schema = {
    type: 'object',
    required: ['sources'],
    properties: { sources: { type: 'array', minItems: 1 } },
    additionalProperties: false,
  };
  okOn({ sources: ['a'] }, schema);
  const missing = badOn({}, schema, 'required');
  assert.match(missing.errors[0].message, /sources/);
  badOn({ sources: [] }, schema, 'minItems');
  badOn({ sources: ['a'], extra: 1 }, schema, 'additionalProperties');
});

test('additionalProperties as a schema constrains the extra keys', () => {
  const schema = { additionalProperties: { type: 'integer' } };
  okOn({ a: 1, b: 2 }, schema);
  const r = badOn({ a: 'x' }, schema, 'type');
  assert.equal(r.errors[0].path, '#/a');
});

test('property bounds', () => {
  badOn({}, { minProperties: 1 }, 'minProperties');
  badOn({ a: 1, b: 2 }, { maxProperties: 1 }, 'maxProperties');
});

test('nested paths are reported precisely', () => {
  const schema = { properties: { findings: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
  const r = badOn({ findings: [{ id: 'a' }, { id: 7 }] }, schema, 'type');
  assert.equal(r.errors[0].path, '#/findings/1/id');
});

test('a type mismatch stops descending so the report stays readable', () => {
  const r = badOn('not-an-object', { type: 'object', required: ['a'], properties: { a: { type: 'string' } } }, 'type');
  assert.equal(r.errors.length, 1, JSON.stringify(r.errors));
});

// ---------------------------------------------------------------- validateWorkflow

const node = (id) => ({ id, prompt: `do ${id}` });
const stringContract = { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false };

test('a well-formed workflow validates and returns a topological order', () => {
  // One entry point, fanning out to two producers, joined by one sink: the shape the
  // protocol requires (exactly one start, at least one end, everything reachable).
  const r = validateWorkflow({
    nodes: [node('c'), node('a'), node('b'), node('s')],
    edges: [
      { from: 's', to: 'a', when: stringContract },
      { from: 's', to: 'b', when: stringContract },
      { from: 'a', to: 'c', when: stringContract },
      { from: 'b', to: 'c', when: stringContract },
    ],
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ['s', 'a', 'b', 'c']);
  // This helper builds nodes without `label`, so a missing role is reported as ADVICE:
  // the graph still validates and runs; the diagram just shows no role for them.
  assert.equal(r.advice.length, 1);
  assert.equal(r.advice[0].keyword, 'label');
});

test('unknown edge endpoints, self edges and missing contracts are refused', () => {
  const r = validateWorkflow({
    nodes: [node('a')],
    edges: [
      { from: 'a', to: 'ghost', when: stringContract },
      { from: 'ghost', to: 'a', when: stringContract },
      { from: 'a', to: 'a', when: stringContract },
      { from: 'a', to: 'a' },
    ],
  });
  assert.equal(r.ok, false);
  const keywords = r.problems.map((p) => p.keyword);
  assert.ok(keywords.includes('from'));
  assert.ok(keywords.includes('to'));
  assert.ok(keywords.includes('edge'));
  assert.ok(keywords.includes('when'), 'an edge without a contract must be refused');
});

test('duplicate node ids, empty nodes and non-objects are refused', () => {
  assert.equal(validateWorkflow({ nodes: [node('a'), node('a')], edges: [] }).ok, false);
  assert.equal(validateWorkflow({ nodes: [], edges: [] }).ok, false);
  assert.equal(validateWorkflow({ nodes: [{ prompt: 'x' }], edges: [] }).ok, false);
  assert.equal(validateWorkflow(null).ok, false);
  assert.equal(validateWorkflow({ nodes: [node('a')] }).ok, true, 'edges may be absent');
});

test('a cycle is refused and the unresolved nodes are named', () => {
  const r = validateWorkflow({
    nodes: [node('a'), node('b'), node('c')],
    edges: [
      { from: 'a', to: 'b', when: stringContract },
      { from: 'b', to: 'a', when: stringContract },
    ],
  });
  assert.equal(r.ok, false);
  const cycle = r.problems.find((p) => p.keyword === 'cycle');
  assert.ok(cycle);
  // c is a resolvable root, so it must not appear in the unresolved list.
  assert.match(cycle.message, /unresolved nodes: a, b$/);
});

test('an unsupported edge contract is refused at workflow level', () => {
  const r = validateWorkflow({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', when: { $ref: '#/x' } }] });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].keyword, '$ref');
  assert.equal(r.problems[0].path, '#/edges/0/when');
});

test('node kinds are checked: a decision needs distinct branches and a default, a join needs two inputs', () => {
  const anySpec = { type: 'object' };
  const decisionOk = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 'd', label: '分流', kind: 'decision' }, { id: 'x', label: '命中' }, { id: 'y', label: '兜底' }],
    edges: [
      { from: 's', to: 'd', when: stringContract },
      { from: 'd', to: 'x', when: { type: 'object', required: ['hit'], properties: { hit: { type: 'boolean' } } } },
      { from: 'd', to: 'y', when: anySpec },
    ],
  });
  assert.deepEqual(decisionOk.problems, [], 'a decision with distinct branches and one default is legal');

  const noDefault = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 'd', label: '分流', kind: 'decision' }, { id: 'x', label: '甲' }, { id: 'y', label: '乙' }],
    edges: [
      { from: 's', to: 'd', when: stringContract },
      { from: 'd', to: 'x', when: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } } },
      { from: 'd', to: 'y', when: { type: 'object', required: ['b'], properties: { b: { type: 'string' } } } },
    ],
  });
  assert.equal(noDefault.ok, false);
  assert.ok(noDefault.problems.some((p) => /default/.test(p.message)), 'the missing default is named');

  const twinBranches = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 'd', label: '分流', kind: 'decision' }, { id: 'x', label: '甲' }, { id: 'y', label: '乙' }],
    edges: [
      { from: 's', to: 'd', when: stringContract },
      { from: 'd', to: 'x', when: anySpec },
      { from: 'd', to: 'y', when: anySpec },
    ],
  });
  assert.equal(twinBranches.ok, false);
  assert.ok(twinBranches.problems.some((p) => /same contract/.test(p.message)));

  const joinOk = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 'a', label: '甲' }, { id: 'b', label: '乙' }, { id: 'j', label: '汇聚', kind: 'join' }],
    edges: [
      { from: 's', to: 'a', when: stringContract },
      { from: 's', to: 'b', when: stringContract },
      { from: 'a', to: 'j', when: anySpec },
      { from: 'b', to: 'j', when: anySpec },
    ],
  });
  assert.deepEqual(joinOk.problems, [], 'a join with two inputs and the default policy is legal');

  const joinPartial = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 'a', label: '甲' }, { id: 'j', label: '汇聚', kind: 'join', waitPolicy: 'any' }],
    edges: [
      { from: 's', to: 'a', when: stringContract },
      { from: 'a', to: 'j', when: anySpec },
    ],
  });
  assert.equal(joinPartial.ok, false);
  assert.ok(joinPartial.problems.some((p) => /not implemented/.test(p.message)), 'a policy the layer cannot honour is refused, not ignored');

  const endWithOut = validateWorkflow({
    nodes: [{ id: 's', label: '开始', kind: 'end' }, { id: 't', label: '后' }],
    edges: [{ from: 's', to: 't', when: stringContract }],
  });
  assert.ok(endWithOut.problems.some((p) => /end node may not have outgoing/.test(p.message)));

  const unknownKind = validateWorkflow({ nodes: [{ id: 's', label: '开始', kind: 'branch' }], edges: [] });
  assert.ok(unknownKind.problems.some((p) => p.keyword === 'kind'));

  const loopDeclared = validateWorkflow({
    nodes: [{ id: 's', label: '开始' }, { id: 't', label: '后' }],
    edges: [{ from: 's', to: 't', when: stringContract }, { from: 't', to: 's', when: stringContract }],
  });
  assert.equal(loopDeclared.ok, false, 'a cycle is still refused');
  assert.ok(loopDeclared.problems.some((p) => p.keyword === 'cycle'));
});
