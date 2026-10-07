/**
 * Phase-2 judges: the 10 requirements the plugin set is supposed to cover
 * natively (✅ R1 R2 R4 R5 R6 R8 R11 R13 R14 R15).
 *
 * These are PURE functions over a trace document, so the judging logic is
 * unit-testable without the host. Producing the trace from a real run is the
 * one manual step (see README.md) because the plugin's output shape is not
 * observable from here; a missing field therefore fails LOUDLY instead of
 * being silently treated as a pass.
 */

export const PASS = 'PASS';
export const FAIL = 'FAIL';

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const asArr = (v) => (Array.isArray(v) ? v : null);
const isBool = (v) => typeof v === 'boolean';

const ok = (id, req, measured, evidence) => ({ id, req, status: PASS, measured, evidence });
const bad = (id, req, measured, evidence) => ({ id, req, status: FAIL, measured, evidence });

function findCycle(names, index, stages) {
  const state = new Map();
  const path = [];
  const visit = (name) => {
    const st = state.get(name) ?? 0;
    if (st === 2) return null;
    if (st === 1) return [...path.slice(path.indexOf(name)), name];
    state.set(name, 1);
    path.push(name);
    for (const up of stages[index.get(name)].upstream ?? []) {
      const c = visit(up);
      if (c) return c;
    }
    path.pop();
    state.set(name, 2);
    return null;
  };
  for (const n of names) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

export function checkR1(t) {
  const id = 'R1';
  const req = '接受一个任务';
  const run = t?.run;
  if (!run || !isNum(run.exitCode)) {
    return bad(id, req, 'run.exitCode 缺失', 'trace 未记录 run.exitCode；先跑一次 /workflow 并记录退出码');
  }
  const stages = asArr(run.stages);
  if (stages === null) return bad(id, req, 'run.stages 缺失', 'trace 未记录 run.stages 数组');
  if (run.exitCode !== 0) return bad(id, req, `exitCode=${run.exitCode}`, '工作流未正常结束');
  if (stages.length < 1) return bad(id, req, 'stages=0', '没有产出任何阶段');
  return ok(id, req, `exitCode=0, stages=${stages.length}`, isStr(run.command) ? run.command : '(未记录命令)');
}

export function checkR2(t) {
  const id = 'R2';
  const req = '自主把任务拆分成几个阶段';
  const stages = asArr(t?.run?.stages);
  if (stages === null) return bad(id, req, 'run.stages 缺失', 'trace 未记录 run.stages 数组');
  if (stages.length < 2) return bad(id, req, `stages=${stages.length}`, '阶段数少于 2，不构成拆分');
  const named = stages.filter((s) => isStr(s?.name)).length;
  if (named !== stages.length) return bad(id, req, `命名阶段 ${named}/${stages.length}`, '存在无名阶段');
  return ok(id, req, `stages=${stages.length}`, stages.map((s) => s.name).join(' -> '));
}

export function checkR4(t) {
  const id = 'R4';
  const req = '解析几个阶段之间的关联';
  const stages = asArr(t?.run?.stages);
  if (stages === null || stages.length === 0) return bad(id, req, 'stages 缺失或为空', '无法构建依赖图');
  const names = [];
  for (const s of stages) {
    if (!s || !isStr(s.name)) return bad(id, req, '存在无名阶段', '每个阶段必须有非空 name 才能建图');
    names.push(s.name);
  }
  if (new Set(names).size !== names.length) return bad(id, req, `重复名: ${names.join(',')}`, '阶段名必须唯一');

  const index = new Map(names.map((n, i) => [n, i]));
  let edges = 0;
  for (const s of stages) {
    const up = asArr(s.upstream);
    if (up === null) return bad(id, req, `${s.name}.upstream 缺失`, '每个阶段都要有 upstream 数组（根阶段给 []）');
    for (const u of up) {
      if (!isStr(u) || !index.has(u)) return bad(id, req, `${s.name} 的上游 "${u}" 不存在`, '存在悬空依赖引用');
      if (u === s.name) return bad(id, req, `${s.name} 依赖自身`, '自依赖无法推进');
      edges += 1;
    }
  }
  if (edges === 0) return bad(id, req, 'edges=0', '没有任何阶段间依赖，说明关联未被解析');
  const cycle = findCycle(names, index, stages);
  if (cycle) return bad(id, req, `环: ${cycle.join(' -> ')}`, '依赖成环，无法推进');
  const roots = stages.filter((s) => (s.upstream ?? []).length === 0).length;
  return ok(id, req, `edges=${edges}, roots=${roots}, stages=${stages.length}`, '非根阶段均有非空上游，无悬空引用，无环');
}

export function checkR5(t) {
  const id = 'R5';
  const req = '对应生成若干子代理';
  const stages = asArr(t?.run?.stages);
  const subs = asArr(t?.run?.subagents);
  if (stages === null) return bad(id, req, 'run.stages 缺失', 'trace 未记录 run.stages');
  if (subs === null) return bad(id, req, 'run.subagents 缺失', 'trace 未记录 run.subagents 数组');
  if (stages.length === 0) return bad(id, req, 'stages=0', '无阶段可比对');
  if (subs.length !== stages.length) {
    return bad(id, req, `subagents=${subs.length}, stages=${stages.length}`, '子代理数与阶段数不一致');
  }
  const withId = subs.filter((s) => isStr(s?.id)).length;
  if (withId !== subs.length) return bad(id, req, `有 id 的子代理 ${withId}/${subs.length}`, '每个子代理都要有非空 id');
  return ok(id, req, `subagents=${subs.length} = stages=${stages.length}`, subs.map((s) => s.id).join(', '));
}

export function checkR6(t) {
  const id = 'R6';
  const req = '子代理之间相互独立，不能直接交流';
  const subs = asArr(t?.run?.subagents);
  if (subs === null) return bad(id, req, 'run.subagents 缺失', 'trace 未记录 run.subagents');
  if (subs.length < 2) return bad(id, req, `subagents=${subs.length}`, '少于 2 个子代理无法验证隔离');
  let refs = 0;
  const offenders = [];
  for (const s of subs) {
    const seen = asArr(s?.seesOtherSubagents);
    if (seen === null) {
      return bad(id, req, `${s?.id ?? '?'}.seesOtherSubagents 缺失`, '每个子代理都要记录它在自己上下文里观察到的其它子代理 id（应为 []）');
    }
    const foreign = seen.filter((o) => o !== s.id);
    if (foreign.length > 0) {
      refs += foreign.length;
      offenders.push(`${s.id}->[${foreign.join(',')}]`);
    }
  }
  if (refs > 0) return bad(id, req, `跨子代理引用=${refs}`, offenders.join(' '));
  return ok(id, req, `跨子代理引用=0 (检查了 ${subs.length} 个)`, '无子代理能看到其它子代理');
}

export function checkR8(t) {
  const id = 'R8';
  const req = '为每个子代理分配对应工作的插件和预设模式';
  const stages = asArr(t?.run?.stages);
  if (stages === null || stages.length === 0) return bad(id, req, 'stages 缺失或为空', '无法检查分配');
  const missing = stages.filter((s) => !isStr(s?.preset)).map((s) => s?.name ?? '?');
  if (missing.length > 0) return bad(id, req, `缺 preset 的阶段: ${missing.join(', ')}`, '每个阶段都必须有非空 preset');
  const presets = [...new Set(stages.map((s) => s.preset.trim()))];
  return ok(id, req, `presets=${presets.length} 种, 覆盖 ${stages.length}/${stages.length} 阶段`, presets.join(', '));
}

export function checkR11(t) {
  const id = 'R11';
  const req = '全部完成之后自动保存结果和完整全套流程图';
  const arts = asArr(t?.run?.artifacts);
  if (arts === null) return bad(id, req, 'run.artifacts 缺失', 'trace 未记录 run.artifacts 数组');
  const badShape = arts.filter((a) => !isStr(a?.path) || !isNum(a?.bytes));
  if (badShape.length > 0) return bad(id, req, `${badShape.length} 个产物缺 path/bytes`, '每个产物都要有非空 path 与数值 bytes');
  // Zero-byte first: it is the more precise diagnosis than "the kind is missing".
  const zero = arts.filter((a) => a.bytes === 0).map((a) => a.path);
  if (zero.length > 0) return bad(id, req, `0 字节产物: ${zero.join(', ')}`, '存在空产物，不算落盘成功');
  const results = arts.filter((a) => a.kind === 'result');
  const flows = arts.filter((a) => a.kind === 'flowchart');
  if (results.length === 0) return bad(id, req, 'result 产物=0', '没有结果文件落盘');
  if (flows.length === 0) return bad(id, req, 'flowchart 产物=0', '没有流程图落盘（R11 要求"完整全套流程图"）');
  const unknown = arts.filter((a) => a.kind !== 'result' && a.kind !== 'flowchart').map((a) => a.path);
  if (unknown.length > 0) return bad(id, req, `未知 kind: ${unknown.join(', ')}`, "kind 只能是 'result' 或 'flowchart'");
  return ok(id, req, `result=${results.length}, flowchart=${flows.length}, 全部 >0 字节`, arts.map((a) => `${a.kind}:${a.path}(${a.bytes}B)`).join(' '));
}

export function checkR13(t) {
  const id = 'R13';
  const req = '库为空或没有合适的 → 按 R1–R11 新建';
  const e = t?.library?.emptyRun;
  if (!e || !isNum(e.exitCode) || !isStr(e.decision)) {
    return bad(id, req, 'library.emptyRun 缺失', '需要记录清空库后那次运行的 {exitCode, decision}');
  }
  if (e.exitCode !== 0) return bad(id, req, `exitCode=${e.exitCode}`, '空库运行报错');
  if (e.decision !== 'create') return bad(id, req, `decision=${e.decision}`, "空库必须走新建路径（decision 应为 'create'）");
  return ok(id, req, `exitCode=0, decision=create`, '空库正确走新建路径');
}

export function checkR14(t) {
  const id = 'R14';
  const req = '有合适的 → 直接按该流程图执行';
  const s = t?.library?.secondRun;
  if (!s || !isBool(s.reused) || !isBool(s.resplit)) {
    return bad(id, req, 'library.secondRun 缺失', '需要记录二次运行同任务的 {reused, resplit}');
  }
  if (s.reused !== true) return bad(id, req, `reused=${s.reused}`, '二次运行没有复用已存流程图');
  if (s.resplit !== false) return bad(id, req, `resplit=${s.resplit}`, '二次运行重新拆分了阶段，说明没有按已存流程图执行');
  return ok(id, req, 'reused=true, resplit=false', '二次运行直接复用，未重新拆分');
}

export function checkR15(t) {
  const id = 'R15';
  const req = '流程图管理：可删除、增加自建流程图、改名';
  const m = t?.management;
  if (!m) return bad(id, req, 'management 缺失', '需要记录增/删/改名三项观察结果');
  const problems = [];

  const add = m.add;
  if (!add || !isNum(add.before) || !isNum(add.after)) problems.push('add 缺 {before, after} 计数');
  else if (add.after !== add.before + 1) problems.push(`add: ${add.before} -> ${add.after} (期望 +1)`);

  const ren = m.rename;
  if (!ren || !isBool(ren.renamed) || !isStr(ren.before) || !isStr(ren.after)) problems.push('rename 缺 {before, after, renamed}');
  else if (ren.renamed !== true) problems.push('rename: renamed=false');
  else if (ren.before === ren.after) problems.push('rename: 名字未变化');

  const del = m.delete;
  if (!del || !isNum(del.before) || !isNum(del.after)) problems.push('delete 缺 {before, after} 计数');
  else if (del.after !== del.before - 1 || del.after < 0) problems.push(`delete: ${del.before} -> ${del.after} (期望 -1 且 >=0)`);

  if (problems.length > 0) return bad(id, req, `${problems.length} 项不符: ${problems.join('; ')}`, '增/改名/删 三项都必须符合预期');
  return ok(id, req, `add ${add.before}->${add.after}, rename "${ren.before}"->"${ren.after}", delete ${del.before}->${del.after}`, '增/改名/删 三项均符合预期');
}

/**
 * ✅ core set: verified against the OFFICIAL seam (see ../OFFICIAL-SEAM.md).
 * These must PASS before phase 3 may start.
 */
export const CORE_CHECKS = Object.freeze([
  { id: 'R1', title: '接受一个任务', fn: checkR1 },
  { id: 'R2', title: '自主把任务拆分成几个阶段', fn: checkR2 },
  { id: 'R4', title: '解析几个阶段之间的关联', fn: checkR4 },
  { id: 'R5', title: '对应生成若干子代理', fn: checkR5 },
  { id: 'R6', title: '子代理之间相互独立，不能直接交流', fn: checkR6 },
  { id: 'R8', title: '为每个子代理分配对应工作的插件和预设模式', fn: checkR8 },
  { id: 'R13', title: '库为空或没有合适的 → 按 R1–R11 新建', fn: checkR13 },
]);

/**
 * [三方待核验] set: the official seam explicitly has NO saved/nested workflow
 * and does NOT persist results or topology, so these only hold if the
 * third-party plugin actually provides them. They are reported, not gated,
 * unless the caller opts in with --require-plugin-claims.
 */
export const PLUGIN_CLAIM_CHECKS = Object.freeze([
  { id: 'R11', title: '全部完成之后自动保存结果和完整全套流程图', fn: checkR11 },
  { id: 'R14', title: '有合适的 → 直接按该流程图执行', fn: checkR14 },
  { id: 'R15', title: '流程图管理：可删除、增加自建流程图、改名', fn: checkR15 },
]);

/** Every judge, in requirement order. */
export const CHECKS = Object.freeze([...CORE_CHECKS, ...PLUGIN_CLAIM_CHECKS]);

export function runChecks(list, trace) {
  return list.map((c) => {
    try {
      const r = c.fn(trace);
      return { ...r, title: c.title };
    } catch (err) {
      return {
        id: c.id,
        title: c.title,
        req: c.title,
        status: FAIL,
        measured: '判定函数抛异常',
        evidence: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export const runAll = (trace) => runChecks(CHECKS, trace);
export const runCore = (trace) => runChecks(CORE_CHECKS, trace);
export const runPluginClaims = (trace) => runChecks(PLUGIN_CLAIM_CHECKS, trace);

export function summarize(results) {
  const total = results.length;
  const passed = results.filter((r) => r.status === PASS).length;
  return { total, passed, failed: total - passed, allPass: passed === total };
}
