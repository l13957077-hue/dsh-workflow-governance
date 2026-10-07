/**
 * R7 / D1: edge data contracts.
 *
 * An edge is `{ from, to, when }` where `when` is a JSON Schema describing the
 * payload that may travel along that edge. This module is the contract layer
 * only: a bounded JSON Schema validator plus workflow (DAG) validation. It does
 * no spawning and touches no host API, so it is fully testable.
 *
 * The safety-critical rule: an UNSUPPORTED keyword is a REFUSAL, never an
 * ignored constraint. If a contract says `patternProperties` or `$ref` and we
 * cannot enforce it, running the workflow would silently drop a constraint the
 * author believed was protecting the edge. checkContractSupport() exists so the
 * caller can refuse before anything runs.
 */

/** Keywords we can enforce. Anything else in a contract is a refusal. */
const ENFORCED = new Set([
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'minProperties',
  'maxProperties',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
]);

/** Keywords that carry no constraint, so ignoring them cannot drop protection. */
const ANNOTATION = new Set([
  '$schema',
  '$id',
  '$comment',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

export const ENFORCED_KEYWORDS = Object.freeze([...ENFORCED].sort());
export const ANNOTATION_KEYWORDS = Object.freeze([...ANNOTATION].sort());

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeNameOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, wanted) {
  const actual = typeNameOf(value);
  if (wanted === 'number') return actual === 'number' || actual === 'integer';
  if (wanted === 'integer') return actual === 'integer';
  return actual === wanted;
}

/**
 * Static support check for one contract. A boolean schema (`true`/`false`) is
 * valid JSON Schema and is supported.
 * @returns {{ok: boolean, problems: Array<{path: string, keyword: string, message: string}>}}
 */
export function checkContractSupport(schema, path = '#') {
  const problems = [];

  const walk = (node, at) => {
    if (typeof node === 'boolean') return;
    if (!isPlainObject(node)) {
      problems.push({ path: at, keyword: 'schema', message: `a schema must be an object or boolean, got ${typeNameOf(node)}` });
      return;
    }
    for (const [keyword, value] of Object.entries(node)) {
      if (ANNOTATION.has(keyword)) continue;
      if (!ENFORCED.has(keyword)) {
        problems.push({ path: at, keyword, message: `unsupported keyword '${keyword}': this layer cannot enforce it, so running would silently drop the constraint` });
        continue;
      }
      switch (keyword) {
        case 'type': {
          const list = Array.isArray(value) ? value : [value];
          for (const one of list) {
            if (!TYPES.has(one)) problems.push({ path: at, keyword, message: `unknown type '${String(one)}'` });
          }
          break;
        }
        case 'properties': {
          if (!isPlainObject(value)) {
            problems.push({ path: at, keyword, message: 'properties must be an object' });
            break;
          }
          for (const [key, sub] of Object.entries(value)) walk(sub, `${at}/properties/${key}`);
          break;
        }
        case 'additionalProperties':
          if (typeof value !== 'boolean' && !isPlainObject(value)) {
            problems.push({ path: at, keyword, message: 'additionalProperties must be a boolean or a schema' });
          } else if (isPlainObject(value)) {
            walk(value, `${at}/additionalProperties`);
          }
          break;
        case 'items':
          if (Array.isArray(value)) value.forEach((sub, i) => walk(sub, `${at}/items/${i}`));
          else walk(value, `${at}/items`);
          break;
        case 'allOf':
        case 'anyOf':
        case 'oneOf':
          if (!Array.isArray(value) || value.length === 0) {
            problems.push({ path: at, keyword, message: `${keyword} must be a non-empty array of schemas` });
            break;
          }
          value.forEach((sub, i) => walk(sub, `${at}/${keyword}/${i}`));
          break;
        case 'not':
          walk(value, `${at}/not`);
          break;
        case 'pattern': {
          if (typeof value !== 'string') {
            problems.push({ path: at, keyword, message: 'pattern must be a string' });
            break;
          }
          try {
            new RegExp(value);
          } catch (error) {
            problems.push({ path: at, keyword, message: `pattern is not a valid regular expression: ${error.message}` });
          }
          break;
        }
        case 'exclusiveMinimum':
        case 'exclusiveMaximum':
          if (typeof value === 'boolean') {
            problems.push({ path: at, keyword, message: `${keyword} as a boolean (draft-04 form) is unsupported; use the numeric form` });
          } else if (typeof value !== 'number') {
            problems.push({ path: at, keyword, message: `${keyword} must be a number` });
          }
          break;
        case 'enum':
          if (!Array.isArray(value) || value.length === 0) {
            problems.push({ path: at, keyword, message: 'enum must be a non-empty array' });
          }
          break;
        case 'required':
          if (!Array.isArray(value) || value.some((k) => typeof k !== 'string')) {
            problems.push({ path: at, keyword, message: 'required must be an array of strings' });
          }
          break;
        case 'minimum':
        case 'maximum':
        case 'multipleOf':
        case 'minProperties':
        case 'maxProperties':
        case 'minItems':
        case 'maxItems':
        case 'minLength':
        case 'maxLength':
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            problems.push({ path: at, keyword, message: `${keyword} must be a finite number` });
          }
          break;
        case 'uniqueItems':
          if (typeof value !== 'boolean') problems.push({ path: at, keyword, message: 'uniqueItems must be a boolean' });
          break;
        case 'const':
          break;
        default:
          break;
      }
    }
  };

  walk(schema, path);
  return { ok: problems.length === 0, problems };
}

/** Structural equality good enough for enum/const/uniqueItems on JSON values. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeNameOf(a) !== typeNameOf(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Validate a value against one already-support-checked contract.
 * @returns {{ok: boolean, errors: Array<{path: string, keyword: string, message: string}>}}
 */
export function validateValue(value, schema, path = '#') {
  const errors = [];
  const fail = (at, keyword, message) => errors.push({ path: at, keyword, message });

  const walk = (node, val, at) => {
    if (node === true || node === undefined || node === null) return;
    if (node === false) {
      fail(at, 'false', 'the contract is `false`, which admits nothing');
      return;
    }
    if (!isPlainObject(node)) return;

    if (node.type !== undefined) {
      const list = Array.isArray(node.type) ? node.type : [node.type];
      if (!list.some((one) => matchesType(val, one))) {
        fail(at, 'type', `expected ${list.join('|')}, got ${typeNameOf(val)}`);
        return; // further keywords would only produce noise
      }
    }
    if (node.const !== undefined && !deepEqual(val, node.const)) {
      fail(at, 'const', `expected the constant ${JSON.stringify(node.const)}`);
    }
    if (Array.isArray(node.enum) && !node.enum.some((c) => deepEqual(val, c))) {
      fail(at, 'enum', `not one of ${JSON.stringify(node.enum)}`);
    }
    if (Array.isArray(node.allOf)) node.allOf.forEach((s, i) => walk(s, val, `${at}/allOf/${i}`));
    if (Array.isArray(node.anyOf) && !node.anyOf.some((s) => validateValue(val, s, at).ok)) {
      fail(at, 'anyOf', 'matches none of the alternatives');
    }
    if (Array.isArray(node.oneOf)) {
      const hits = node.oneOf.filter((s) => validateValue(val, s, at).ok).length;
      if (hits !== 1) fail(at, 'oneOf', `must match exactly one alternative, matched ${hits}`);
    }
    if (node.not !== undefined && validateValue(val, node.not, at).ok) {
      fail(at, 'not', 'must not match the excluded schema');
    }

    if (typeof val === 'string') {
      if (typeof node.minLength === 'number' && val.length < node.minLength) fail(at, 'minLength', `length ${val.length} < ${node.minLength}`);
      if (typeof node.maxLength === 'number' && val.length > node.maxLength) fail(at, 'maxLength', `length ${val.length} > ${node.maxLength}`);
      if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(val)) fail(at, 'pattern', `does not match /${node.pattern}/`);
    }

    if (typeof val === 'number' && Number.isFinite(val)) {
      if (typeof node.minimum === 'number' && val < node.minimum) fail(at, 'minimum', `${val} < ${node.minimum}`);
      if (typeof node.maximum === 'number' && val > node.maximum) fail(at, 'maximum', `${val} > ${node.maximum}`);
      if (typeof node.exclusiveMinimum === 'number' && val <= node.exclusiveMinimum) fail(at, 'exclusiveMinimum', `${val} <= ${node.exclusiveMinimum}`);
      if (typeof node.exclusiveMaximum === 'number' && val >= node.exclusiveMaximum) fail(at, 'exclusiveMaximum', `${val} >= ${node.exclusiveMaximum}`);
      if (typeof node.multipleOf === 'number' && node.multipleOf > 0 && Math.abs(val / node.multipleOf - Math.round(val / node.multipleOf)) > 1e-9) {
        fail(at, 'multipleOf', `not a multiple of ${node.multipleOf}`);
      }
    }

    if (Array.isArray(val)) {
      if (typeof node.minItems === 'number' && val.length < node.minItems) fail(at, 'minItems', `${val.length} < ${node.minItems}`);
      if (typeof node.maxItems === 'number' && val.length > node.maxItems) fail(at, 'maxItems', `${val.length} > ${node.maxItems}`);
      if (node.uniqueItems === true) {
        for (let i = 0; i < val.length; i += 1) {
          for (let j = i + 1; j < val.length; j += 1) {
            if (deepEqual(val[i], val[j])) {
              fail(at, 'uniqueItems', `items ${i} and ${j} are equal`);
              i = val.length;
              break;
            }
          }
        }
      }
      if (node.items !== undefined) {
        if (Array.isArray(node.items)) node.items.forEach((s, i) => { if (i < val.length) walk(s, val[i], `${at}/${i}`); });
        else val.forEach((item, i) => walk(node.items, item, `${at}/${i}`));
      }
    }

    if (isPlainObject(val)) {
      const keys = Object.keys(val);
      if (typeof node.minProperties === 'number' && keys.length < node.minProperties) fail(at, 'minProperties', `${keys.length} < ${node.minProperties}`);
      if (typeof node.maxProperties === 'number' && keys.length > node.maxProperties) fail(at, 'maxProperties', `${keys.length} > ${node.maxProperties}`);
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (!Object.prototype.hasOwnProperty.call(val, key)) fail(at, 'required', `missing required property '${key}'`);
        }
      }
      const declared = isPlainObject(node.properties) ? node.properties : {};
      for (const [key, sub] of Object.entries(declared)) {
        if (Object.prototype.hasOwnProperty.call(val, key)) walk(sub, val[key], `${at}/${key}`);
      }
      if (node.additionalProperties !== undefined) {
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(declared, key)) continue;
          if (node.additionalProperties === false) fail(at, 'additionalProperties', `unexpected property '${key}'`);
          else if (isPlainObject(node.additionalProperties)) walk(node.additionalProperties, val[key], `${at}/${key}`);
        }
      }
    }
  };

  walk(schema, value, path);
  return { ok: errors.length === 0, errors };
}

/**
 * The entry point callers should use: support check first (fail-closed), then
 * validation. Never silently downgrades an unsupported contract to a pass.
 */
export function validateContract(value, schema, path = '#') {
  const support = checkContractSupport(schema, path);
  if (!support.ok) return { ok: false, unsupported: true, errors: [], problems: support.problems };
  const result = validateValue(value, schema, path);
  return { ok: result.ok, unsupported: false, errors: result.errors, problems: [] };
}

/**
 * Validate a DAG: unique ids, edges that resolve, no self edge, no cycle, and
 * every edge contract supported.
 * @returns {{ok: boolean, problems: Array<{path: string, keyword: string, message: string}>, order: string[]}}
 */
export function validateWorkflow(workflow) {
  const problems = [];
  const push = (path, keyword, message) => problems.push({ path, keyword, message });

  if (!isPlainObject(workflow)) {
    push('#', 'workflow', 'a workflow must be an object');
    return { ok: false, problems, order: [] };
  }
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : null;
  if (nodes === null || nodes.length === 0) {
    push('#/nodes', 'nodes', 'nodes must be a non-empty array');
    return { ok: false, problems, order: [] };
  }
  const ids = [];
  nodes.forEach((node, i) => {
    if (!isPlainObject(node) || typeof node.id !== 'string' || node.id === '') {
      push(`#/nodes/${i}`, 'id', 'every node needs a non-empty string id');
      return;
    }
    ids.push(node.id);
  });
  if (new Set(ids).size !== ids.length) push('#/nodes', 'id', 'node ids must be unique');
  if (problems.length > 0) return { ok: false, problems, order: [] };

  const idSet = new Set(ids);
  const edges = Array.isArray(workflow.edges) ? workflow.edges : [];
  edges.forEach((edge, i) => {
    if (!isPlainObject(edge)) {
      push(`#/edges/${i}`, 'edge', 'an edge must be an object');
      return;
    }
    if (!idSet.has(edge.from)) push(`#/edges/${i}/from`, 'from', `unknown node '${String(edge.from)}'`);
    if (!idSet.has(edge.to)) push(`#/edges/${i}/to`, 'to', `unknown node '${String(edge.to)}'`);
    if (edge.from === edge.to) push(`#/edges/${i}`, 'edge', 'an edge may not be a self edge');
    if (edge.when === undefined) {
      push(`#/edges/${i}/when`, 'when', 'an edge must declare a `when` contract; an unconstrained edge is not allowed here');
    } else {
      const support = checkContractSupport(edge.when, `#/edges/${i}/when`);
      problems.push(...support.problems);
    }
  });

  // Kahn's algorithm gives both a topological order and cycle detection.
  const indegree = new Map(ids.map((id) => [id, 0]));
  const adjacency = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!isPlainObject(edge) || !idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }
  const queue = ids.filter((id) => indegree.get(id) === 0).sort();
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adjacency.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
    queue.sort();
  }
  if (order.length !== ids.length) {
    push('#/edges', 'cycle', `the workflow has a cycle; unresolved nodes: ${ids.filter((id) => !order.includes(id)).join(', ')}`);
  }

  // ── The graph shape the protocol requires (step 2) ────────────────────────
  // Only what this model can actually express is CHECKED here; the rest of the protocol
  // is instruction-level, and saying otherwise would be a lie. Checked: exactly one start,
  // at least one end, full reachability from the start, every node able to reach an end,
  // no isolated node (no duplicate id, self edge or cycle -- above).
  const incoming = new Map(ids.map((id) => [id, []]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!isPlainObject(edge) || !idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  const starts = ids.filter((id) => incoming.get(id).length === 0);
  const ends = ids.filter((id) => outgoing.get(id).length === 0);
  if (starts.length !== 1) {
    push('#/nodes', 'start', `a workflow must have exactly ONE start node (a node with no incoming edge); found ${starts.length}: ${starts.join(', ') || 'none'}`);
  }
  if (ends.length === 0) push('#/nodes', 'end', 'a workflow must have at least one end node (a node with no outgoing edge)');
  const closure = (roots, step) => {
    const seen = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      for (const next of step(queue.shift())) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  if (starts.length === 1) {
    const reachable = closure([starts[0]], (id) => outgoing.get(id) ?? []);
    const unreachable = ids.filter((id) => !reachable.has(id));
    if (unreachable.length > 0) push('#/nodes', 'reachable', `every node must be reachable from the start node; unreachable: ${unreachable.join(', ')}`);
  }
  if (ends.length > 0) {
    const canFinish = closure(ends, (id) => incoming.get(id) ?? []);
    const stranded = ids.filter((id) => !canFinish.has(id));
    if (stranded.length > 0) push('#/nodes', 'end', `every node must be able to reach an end node; stranded: ${stranded.join(', ')}`);
  }
  // A node's `label` is what the structure diagram shows as its role, so its absence is
  // reported -- as ADVICE, not as a refusal. Turning it into a hard error overnight would
  // stop every graph saved before the rule existed, and an instruction that silently
  // invalidates the operator's own library is worse than a visible warning.
  // ── Node kinds (step 2 of the protocol) ───────────────────────────────────
  // `kind` is OPTIONAL: an absent kind means `task`, so every graph saved before kinds
  // existed keeps working unchanged. What the kinds buy is that the two shapes with real
  // semantics -- a decision and a join -- are CHECKED instead of merely described.
  const KINDS = new Set(['task', 'decision', 'join', 'end']);
  const WAIT_POLICIES = new Set(['all']);
  const kindOf = (id) => {
    const node = nodes.find((row) => row && row.id === id);
    return typeof node?.kind === 'string' && node.kind !== '' ? node.kind : 'task';
  };
  const outgoingOf = (id) => edges.filter((edge) => isPlainObject(edge) && edge.from === id);
  const incomingOf = (id) => edges.filter((edge) => isPlainObject(edge) && edge.to === id);
  nodes.forEach((node, i) => {
    if (!isPlainObject(node)) return;
    if (node.kind !== undefined && !KINDS.has(node.kind)) {
      push(`#/nodes/${i}/kind`, 'kind', `unknown node kind ${JSON.stringify(node.kind)}; use one of ${[...KINDS].join(', ')}`);
    }
  });
  for (const id of ids) {
    const kind = kindOf(id);
    const outs = outgoingOf(id);
    const ins = incomingOf(id);
    if (kind === 'decision') {
      if (outs.length < 2) push(`#/nodes/${id}`, 'decision', `a decision node must have at least two outgoing edges (found ${outs.length})`);
      // Distinctness is decidable; "mutually exclusive and exhaustive" in general is not,
      // so the layer checks what it can: the branch contracts must differ, and one of them
      // must be the fallback -- a contract that constrains nothing.
      const seen = new Set();
      for (const edge of outs) {
        const fp = JSON.stringify(edge.when ?? null);
        if (seen.has(fp)) push(`#/nodes/${id}`, 'decision', `two branches of this decision carry the same contract: ${String(edge.to)}`);
        seen.add(fp);
      }
      const hasDefault = outs.some((edge) => {
        const spec = edge.when;
        if (!isPlainObject(spec)) return false;
        if (Array.isArray(spec.required) && spec.required.length > 0) return false;
        if (isPlainObject(spec.properties) && Object.keys(spec.properties).length > 0) return false;
        if (spec.additionalProperties === false) return false;
        return true;
      });
      if (outs.length >= 2 && !hasDefault) {
        push(`#/nodes/${id}`, 'decision', 'one outgoing branch of a decision must be the default: a contract that constrains nothing (no required, no properties, not closed)');
      }
    }
    if (kind === 'join') {
      if (ins.length < 2) push(`#/nodes/${id}`, 'join', `a join node must have at least two incoming edges (found ${ins.length})`);
      const policy = nodes.find((row) => row && row.id === id)?.waitPolicy;
      if (policy !== undefined && !WAIT_POLICIES.has(policy)) {
        push(`#/nodes/${id}`, 'waitPolicy', `waitPolicy ${JSON.stringify(policy)} is not implemented; the layer waits for ALL upstream nodes (only "all" is accepted -- a policy it cannot honour is refused rather than silently ignored)`);
      }
    }
    if (kind === 'end' && outs.length > 0) {
      push(`#/nodes/${id}`, 'end', 'an end node may not have outgoing edges');
    }
  }
  if (workflow.loop !== undefined) {
    // Declaring a loop is understood and still refused: this runner executes a DAG in
    // topological order, so honouring `loop` would need an iteration engine. Saying so is
    // better than accepting the declaration and quietly ignoring it.
    push('#/loop', 'loop', 'iteration is not implemented: a declared `loop` would be silently ignored, so cycles are refused. Restructure as explicit rounds, or put the iteration inside one node\'s prompt.');
  }

  const advice = [];
  const unlabelled = ids.filter((id) => {
    const node = nodes.find((row) => row && row.id === id);
    return !(typeof node?.label === 'string' && node.label.trim() !== '');
  });
  if (unlabelled.length > 0) {
    advice.push({
      path: '#/nodes',
      keyword: 'label',
      message: `these nodes carry no \`label\`, so the structure diagram will show no role for them: ${unlabelled.join(', ')}`,
    });
  }
  return { ok: problems.length === 0, problems, order, advice };
}
