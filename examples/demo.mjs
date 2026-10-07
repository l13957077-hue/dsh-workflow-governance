/**
 * Live demo of R7 (edge data contracts) and G1 (saved-workflow library).
 *
 * It drives the REAL code paths: a fake host stands in for cordis, `apply()`
 * registers the tools exactly as it does in the host, and the demo calls those
 * registered tools. Nothing here touches DSH, the profile, or the network.
 *
 * Run: node examples/demo.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apply, TOOL_NAME, LIBRARY_TOOL_NAME } from '../src/plugin.js';
import { runContractGraph, explainRun, RUN_STATUS } from '../src/graph-run.js';
import { createFakeHost } from '../test/fake-host.mjs';

const out = [];
const say = (s = '') => out.push(s);

const CONTRACT = {
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1 } },
  additionalProperties: false,
};
const twoNodeGraph = () => ({
  nodes: [{ id: 'collect', prompt: 'do collect' }, { id: 'synth', prompt: 'do synth' }],
  edges: [{ from: 'collect', to: 'synth', when: CONTRACT }],
});

// ═══════════════════════════════════════════════ 1. R7: the contract gate

say('══ 1. R7 契约门控（spawn 前后校验 + 退回上游）');
{
  const spawns = [];
  const spawn = async ({ node, attempt }) => {
    spawns.push(`${node.id}#${attempt}`);
    if (node.id === 'collect') return attempt === 1 ? { text: '' } : { text: 'seed' };
    return { text: 'done' };
  };
  const r = await runContractGraph({ workflow: twoNodeGraph(), spawn, maxAttemptsPerNode: 3 });
  assert.equal(r.status, RUN_STATUS.COMPLETED);
  say(`  正常完成：spawn 序列 ${spawns.join(' → ')}`);
  say(`  ↑ collect#1 产出违约（minLength）→ 被退回上游重跑；下游只在契约通过后才启动`);
  say(`  最终产出：synth = ${JSON.stringify(r.outputs.synth)}`);
}

say();
say('  ── 违约不可修复时，点名上游并停住 ──');
{
  const spawns = [];
  const spawn = async ({ node, attempt }) => {
    spawns.push(`${node.id}#${attempt}`);
    return { text: '' }; // 永远违约
  };
  const r = await runContractGraph({ workflow: twoNodeGraph(), spawn, maxAttemptsPerNode: 2 });
  assert.equal(r.status, RUN_STATUS.OUTPUT_VIOLATES_CONTRACT);
  assert.equal(r.upstream, 'collect');
  assert.ok(!spawns.some((s) => s.startsWith('synth')), 'synth 从未被启动');
  say(`  ${explainRun(r)}`);
  say(`  spawn 序列 ${spawns.join(' → ')}：synth 一次都没跑`);
}

say();
say('  ── fail-closed：无法强制的契约关键字，一个节点都不 spawn ──');
{
  let created = 0;
  const spawn = async () => {
    created += 1;
    return {};
  };
  const r = await runContractGraph({
    workflow: {
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ from: 'a', to: 'b', when: { $ref: '#/x' } }],
    },
    spawn,
  });
  assert.equal(r.status, RUN_STATUS.INVALID_WORKFLOW);
  assert.equal(created, 0);
  say(`  ${r.problems[0].path} ${r.problems[0].keyword}: ${r.problems[0].message}`);
  say(`  spawn 次数 = ${created}（拒绝是"拒绝执行"，不是"当作无约束"）`);
}

// ═══════════════════════════════════ 2. the real tool surface, via apply()

const dir = mkdtempSync(join(tmpdir(), 'wfg-demo-'));
const configPath = join(dir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify({
    switches: { contracts: true, templateLibrary: true },
    contracts: { maxAttemptsPerNode: 2 },
    library: { root: 'library' },
  }),
  'utf8',
);

const host = createFakeHost();
const registered = new Map();
const disposers = [];
host.ctx.tools = {
  register(definition) {
    registered.set(definition.name, definition);
    return () => registered.delete(definition.name);
  },
};
// The delegation service, in the shape the host's own tool-subagent caller uses:
// start(provider, { label, prompt: [content blocks], parent }) -> run with
// id / result / dispose. NOT `agents`, which is only the agent registry.
let agentCreations = 0;
host.ctx.subagents = {
  start: async (provider, request) => {
    agentCreations += 1;
    const text = request.prompt.map((block) => block.text).join('');
    const answer = text.includes('do collect') ? { text: 'seed' } : text.includes('do synth') ? { text: 'digest' } : { text: 'x' };
    return {
      id: `run-${agentCreations}`,
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: JSON.stringify(answer) }] }),
      dispose: async () => {},
    };
  },
};
/** The tool's `exec`: the calling agent becomes the child's `parent`. */
const DEMO_EXEC = { agent: { id: 'demo-parent' } };
// `defineTool` is injected because in the real host it comes from the host's own
// copy of `@deepseek-ai/dsh-tools` (see lib/index.js). This double is deliberately
// as strict as the host: it reads `options.output.render` first, so a definition
// missing `output` throws here exactly as it does in the host.
const hostShapedDefineTool = (options) => {
  const userRender = options.output.render;
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: { schema: options.output.schema, render: (args, value) => userRender(args, value) },
    execute: (args, exec) => options.execute(args, exec),
  };
};
const dispose = apply(host.ctx, { configPath, defineTool: hostShapedDefineTool });

say();
say('══ 2. 插件注册的工具（apply() 的真实路径）');
say(`  已注册：${[...registered.keys()].join(', ')}`);
assert.ok(registered.has(TOOL_NAME));
assert.ok(registered.has(LIBRARY_TOOL_NAME));
assert.notEqual(TOOL_NAME, 'run_workflow');
say(`  ↑ 刻意不叫 run_workflow：宿主的同名工具存在过，撞名会遮蔽原生能力`);
say(`  日志：${host.logs.info.join(' | ')}`);

const tool = (n) => registered.get(n);
const lib = () => tool(LIBRARY_TOOL_NAME);

// ═════════════════════════════════════════════════════ 3. G1: the library

say();
say('══ 3. G1 已保存工作流库（R15 增删改名）');
{
  const saved = await lib().execute({
    action: 'save',
    definition: {
      name: '并行调查',
      description: '拆成并行子任务后汇总',
      labels: ['investigation', 'parallel'],
      ...twoNodeGraph(),
    },
  });
  assert.equal(saved.ok, true);
  say(`  save「并行调查」→ revision ${saved.entry.revision}，节点 ${saved.entry.nodes}，边 ${saved.entry.edges}`);

  const listed = await lib().execute({ action: 'list' });
  say(`  list → ${listed.entries.map((e) => e.name).join(', ')}`);

  const refused = await lib().execute({
    action: 'save',
    definition: { name: 'bad', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] },
  });
  assert.equal(refused.ok, false);
  say(`  save 缺 when 的边 → 拒绝（${refused.code}）：${refused.problems[0].message.slice(0, 60)}…`);

  const unsupported = await lib().execute({
    action: 'save',
    definition: { name: 'bad2', nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', when: { patternProperties: {} } }] },
  });
  assert.equal(unsupported.code, 'INVALID_WORKFLOW');
  say(`  save 用 patternProperties 的边 → 拒绝（${unsupported.code}）—— 存一个强制不了的等于把书面保证变成静默空操作`);

  const renamed = await lib().execute({ action: 'rename', name: '并行调查', newName: '并行调查-v2' });
  assert.equal(renamed.code, 'RENAMED');
  const removed = await lib().execute({ action: 'remove', name: '并行调查-v2' });
  assert.equal(removed.code, 'REMOVED');
  say(`  rename → ${renamed.code}；remove → ${removed.code}；list → ${(await lib().execute({ action: 'list' })).entries.length} 条`);
}

// ═════════════════════════════════ 4. R12 + R14: pick a stored flow, run it

say();
say('══ 4. R12 查找 + R14 按已存图执行');
{
  await lib().execute({
    action: 'save',
    definition: {
      name: 'parallel-investigation',
      description: '拆成并行子任务后汇总',
      labels: ['investigation', 'parallel'],
      ...twoNodeGraph(),
    },
  });

  const hit = await lib().execute({
    action: 'find',
    query: { name: '并行调查三个子系统', text: '拆成并行子任务后汇总', labels: ['investigation', 'parallel'] },
  });
  say(`  R12 find（同任务）→ ${hit.decision}，命中 ${hit.best.id}，得分 ${hit.best.score.toFixed(4)}`);
  assert.equal(hit.decision, 'reuse');

  const miss = await lib().execute({ action: 'find', query: { name: '写一份菜谱', text: '厨房里的流程', labels: ['cooking'] } });
  say(`  R12 find（无关任务）→ ${miss.decision}（按需求：<0.6 就走新建）`);
  assert.equal(miss.decision, 'create');

  const run = await tool(TOOL_NAME).execute({ name: 'parallel-investigation' }, DEMO_EXEC);
  assert.equal(run.status, RUN_STATUS.COMPLETED);
  say(`  R14 contract_workflow {name} → ${run.status}，产出 synth=${JSON.stringify(run.outputs.synth)}`);

  const [row] = (await lib().execute({ action: 'list' })).entries;
  // The run is recorded with its own automatic score: no retry, no violation, so 1.
  assert.deepEqual(row.stats, { runs: 1, successes: 1, scoreSum: 1, scoredRuns: 1 });
  say(`  R12 历史回写 → stats ${JSON.stringify(row.stats)}（下次打分会用到成功率）`);

  // Captured here, after the successful run, so it measures only the miss.
  const before = agentCreations;
  const missing = await tool(TOOL_NAME).execute({ name: 'no-such-flow' }, DEMO_EXEC);
  assert.equal(missing.status, 'NOT_FOUND');
  assert.equal(agentCreations, before, '不存在的名字不 spawn 任何节点');
  say(`  不存在的名字 → ${missing.status}，spawn 次数仍是 ${before}（没有静默新建）`);

  const exported = await lib().execute({ action: 'export', name: 'parallel-investigation' });
  const imported = await lib().execute({ action: 'import', json: exported.json });
  say(`  export → ${exported.json.length} 字节；import → ${imported.code}（revision ${imported.entry.revision}）`);
}

// ═══════════════════════════════ 5. a corrupt store must not become "empty"

say();
say('══ 5. 损坏的库：报错，而不是当空库被覆盖');
{
  const libFile = join(dir, 'library', 'library.json');
  const good = readFileSync(libFile, 'utf8');
  writeFileSync(libFile, '{ truncated', 'utf8');
  await assert.rejects(() => lib().execute({ action: 'list' }), /not valid JSON/);
  assert.equal(readFileSync(libFile, 'utf8'), '{ truncated', '操作者的字节原封不动');
  say(`  list → 拒绝（/not valid JSON/），文件字节未被改写（长度 ${readFileSync(libFile, 'utf8').length}）`);
  say(`  ↑ 若把它当空库，下一次 save 就会覆盖掉操作者的数据`);
  writeFileSync(libFile, good, 'utf8');
}

// ═══════════════════════════════ 6. the activation self-report

say();
say('══ 6. 激活自检报告（宿主只在失败时写日志，所以这一层必须自己留痕）');
{
  const report = JSON.parse(readFileSync(join(dir, 'state', 'startup.json'), 'utf8'));
  assert.equal(report.defineTool, true, 'the host defineTool was reachable');
  assert.deepEqual(report.registeredTools, [TOOL_NAME, LIBRARY_TOOL_NAME]);
  for (const line of JSON.stringify(report, null, 2).split('\n')) say(`  ${line}`);
}

dispose();
rmSync(dir, { recursive: true, force: true });

console.log(out.join('\n'));
console.log('\nDEMO OK');
