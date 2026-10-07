/**
 * R3: turn a declared workflow graph into a flow diagram.
 *
 * Scope, stated honestly. This renders the graph this layer actually KNOWS:
 * the declared `{ nodes, edges }` of a saved workflow, including each edge's data
 * contract. It deliberately does not try to draw a LIVE run, because the official
 * `workflow/*` events carry no dependency structure at all -- a run's topology can
 * only be inferred as phase order, which `observe.js` marks `inferred:phase-order`
 * and which would make a misleading picture.
 *
 * Output is Mermaid source, not pixels: text is testable, diffable and renderable
 * by whatever the deployment already has. Drawing inside the DSH UI would need a
 * client half and a slot, which is a different (and unverifiable-here) piece of work.
 *
 * Every function is TOTAL: a diagram is a diagnostic, and a diagnostic must never
 * be the thing that throws.
 */

/** Longest label we will emit for one node or edge, before Mermaid chokes on it. */
const MAX_LABEL = 160;

/**
 * Make a string safe inside a Mermaid quoted label.
 *
 * Mermaid has no escaping inside `["..."]`, so quotes become apostrophes and
 * structural characters become words; newlines become `<br/>` so a multi-line
 * prompt stays readable inside one node.
 */
export function escapeLabel(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  const flat = raw
    .replace(/\r\n?/g, '\n')
    // A sentinel, so the <br/> inserted below cannot be eaten by the strip pass.
    .replace(/\n+/g, '\u0000')
    .replace(/"/g, "'")
    // Only the characters that actually break a quoted Mermaid label: the quote
    // itself, the node-shape brackets, the group braces, the edge-label pipe, and
    // the angle brackets that Mermaid reads as HTML. Parentheses are safe inside
    // quotes and carry meaning in a contract summary, so they survive.
    .replace(/[[\]{}|<>]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\u0000/g, '<br/>')
    .trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 3)}...` : flat;
}

/** The node caption: its id, plus a trimmed prompt when there is one.
 *
 * Returns RAW text with a real newline (never `<br/>`): escaping must happen
 * exactly once, in `escapeLabel`, or the escape pass would eat the very markup it
 * just produced.
 */
export function labelForNode(node) {
  const id = node && node.id !== undefined ? String(node.id) : '?';
  const prompt = node && typeof node.prompt === 'string' ? node.prompt.trim() : '';
  if (prompt === '') return id;
  const oneLine = prompt.replace(/\s+/g, ' ');
  const short = oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine;
  return `${id}\n${short}`;
}

/**
 * A short, human label for an edge contract -- enough to see what an edge carries
 * without pasting a whole JSON Schema into the picture.
 *
 * Property details matter for reading a contract at a glance (`minLength 1` is
 * usually the whole point), and they live inside `properties`, so they are
 * summarised too.
 */
export function describeContract(when) {
  try {
    if (when === null || typeof when !== 'object' || Array.isArray(when)) return '';
    const bits = [];
    if (Array.isArray(when.required) && when.required.length > 0) bits.push(`required ${when.required.join(',')}`);
    if (typeof when.type === 'string') bits.push(when.type);
    if (typeof when.minLength === 'number') bits.push(`minLength ${String(when.minLength)}`);
    if (typeof when.minItems === 'number') bits.push(`minItems ${String(when.minItems)}`);
    if (when.properties && typeof when.properties === 'object') {
      const described = Object.entries(when.properties)
        .slice(0, 4)
        .map(([name, spec]) => {
          const isObject = spec !== null && typeof spec === 'object' && !Array.isArray(spec);
          const type = isObject && typeof spec.type === 'string' ? spec.type : 'any';
          const extra = !isObject
            ? []
            : [
                // Deliberately no `<` or `>`: those are stripped as structural
                // characters, and a label needs no comparison syntax anyway.
                typeof spec.minLength === 'number' ? `min${String(spec.minLength)}` : '',
                typeof spec.minItems === 'number' ? `minItems${String(spec.minItems)}` : '',
                Array.isArray(spec.enum) ? `enum${String(spec.enum.length)}` : '',
              ].filter((part) => part !== '');
          return `${name}:${type}${extra.length === 0 ? '' : `(${extra.join(',')})`}`;
        });
      if (described.length > 0) bits.push(`props ${described.join(' ')}`);
    }
    if (when.additionalProperties === false) bits.push('closed');
    return bits.join('; ');
  } catch {
    return '';
  }
}

/**
 * R4: where each edge's relationship actually comes from.
 *
 * A DECLARED edge is one the workflow states, so this layer can enforce a data
 * contract on it. An INFERRED edge is one the official `workflow/*` events allow
 * `observe.js` to guess from phase order -- those events carry no dependency
 * structure at all -- and a guess must never be shown as a fact. Counting the two
 * apart is what makes R4 checkable rather than asserted.
 */
export function edgeProvenance(graph) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  let declared = 0;
  let inferred = 0;
  for (const edge of edges) {
    if (edge && typeof edge.inferred === 'string' && edge.inferred !== '') inferred += 1;
    else if (edge && edge.when !== undefined) declared += 1;
    else inferred += 1; // no contract and no provenance: unproven, so not a fact
  }
  return { declared, inferred, total: edges.length };
}

/** True when this edge is a guess rather than a declaration. */
export function isInferredEdge(edge) {
  if (edge === null || typeof edge !== 'object') return true;
  if (typeof edge.inferred === 'string' && edge.inferred !== '') return true;
  return edge.when === undefined;
}

/** Nodes with no outgoing / no incoming edges: the entry and exit points. */
export function graphEndpoints(graph) {
  try {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const ids = nodes.map((n, i) => String(n?.id ?? i));
    const froms = new Set(edges.map((e) => String(e?.from)));
    const tos = new Set(edges.map((e) => String(e?.to)));
    return {
      sources: ids.filter((id) => !tos.has(id)),
      sinks: ids.filter((id) => !froms.has(id)),
    };
  } catch {
    return { sources: [], sinks: [] };
  }
}

/**
 * Render `{ nodes, edges }` as a Mermaid flowchart.
 *
 * @param graph - the declared workflow.
 * @param options - `direction` ('TD' | 'LR') and an optional `title` comment.
 * @returns Mermaid source; a placeholder diagram when there is nothing to draw.
 */
export function toMermaid(graph, options = {}) {
  try {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const direction = options.direction === 'LR' ? 'LR' : 'TD';
    // The diagram declaration MUST be the first line. Renderers detect a diagram
    // by reading the block's first identifier -- `dsh-mermaid` uses
    // `/^\s*([A-Za-z][\w-]*)/` against a keyword set beginning with `flowchart`.
    // A leading `%%` title comment makes that identifier unmatchable, so the block
    // would stay source code forever. The title therefore goes after it, which
    // Mermaid accepts (a comment is legal on any line).
    const lines = [`flowchart ${direction}`];
    if (typeof options.title === 'string' && options.title !== '') lines.push(`  %% ${escapeLabel(options.title)}`);
    if (nodes.length === 0) {
      lines.push('  nodata["(no nodes declared)"]');
      return lines.join('\n');
    }
    // Mermaid node ids must be stable and safe; the declared ids go in the label.
    const mermaidId = new Map();
    nodes.forEach((node, index) => mermaidId.set(String(node?.id ?? index), `n${String(index)}`));
    nodes.forEach((node, index) => {
      lines.push(`  n${String(index)}["${escapeLabel(labelForNode(node))}"]`);
    });
    for (const edge of edges) {
      const from = mermaidId.get(String(edge?.from));
      const to = mermaidId.get(String(edge?.to));
      // A dangling edge is the validator's business, not the picture's: skip it
      // rather than emit a node that does not exist.
      if (from === undefined || to === undefined) continue;
      const contract = describeContract(edge?.when);
      // R4: an inferred edge is drawn DASHED and says so, so a phase-order guess
      // can never be mistaken for a declared dependency.
      if (isInferredEdge(edge)) {
        const why = typeof edge?.inferred === 'string' && edge.inferred !== '' ? edge.inferred : 'not declared';
        lines.push(`  ${from} -.->|"inferred: ${escapeLabel(why)}"| ${to}`);
        continue;
      }
      lines.push(contract === '' ? `  ${from} --> ${to}` : `  ${from} -->|"${escapeLabel(contract)}"| ${to}`);
    }
    return lines.join('\n');
  } catch {
    return 'flowchart TD\n  failed["diagram unavailable"]';
  }
}

/** The same diagram, fenced so a Mermaid-aware viewer renders it. */
export function toMermaidFence(graph, options = {}) {
  return `\`\`\`mermaid\n${toMermaid(graph, options)}\n\`\`\``;
}

/**
 * A one-line description of the shape, for a tool card that cannot show a picture.
 */
export function describeGraph(graph) {
  try {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
    const edges = Array.isArray(graph?.edges) ? graph.edges.length : 0;
    const { sources, sinks } = graphEndpoints(graph);
    // R4: only mention provenance when there is a guess to disclose, so a fully
    // declared graph keeps its plain one-liner.
    const { inferred } = edgeProvenance(graph);
    const note = inferred > 0 ? ` (${String(inferred)} inferred, not declared)` : '';
    return `${String(nodes)} node(s), ${String(edges)} edge(s)${note} · start ${sources.join(',') || '-'} · end ${sinks.join(',') || '-'}`;
  } catch {
    return 'graph unavailable';
  }
}
