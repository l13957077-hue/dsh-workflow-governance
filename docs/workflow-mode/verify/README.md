# 阶段2 验证：分两套判定

**验证对象按"谁来提供"分成两套**——这是对着**已核验的官方 seam**（`../OFFICIAL-SEAM.md`）重判后的结果：

| 套 | 条目 | 数 | 作用 |
| --- | --- | --- | --- |
| **A. CORE（门禁）** | R1 R2 R4 R5 R6 R8 R13 | 7 | 官方 seam 已核验覆盖。**任一 FAIL → 不得进入阶段3** |
| **B. 插件声称（仅报告）** | R11 R14 R15 | 3 | 官方明确**没有已保存/嵌套工作流**、**不落盘结果与拓扑** → 只有第三方插件提供了才成立 |

两套相加 10 条。整体账：✅7 / ⚠️6 / ❌4 = 17（见 `../LANDING-PLAN.md` 第 1 节）。

> **为什么 B 套不门禁**：把"第三方插件声称有"当成"已经完成"，正是第一轮判错的原因。B 套默认**只报告**；当你在阶段2 实测确认要依赖该第三方插件时，加 `--require-plugin-claims` 才把它纳入门禁。

**目的**：确认 A 套 7 条**确实由官方 seam 覆盖**，从而不必为它们写代码；同时把 B 套的实测结论变成"接受第三方 / 移入自研"的决策依据。任何一条 FAIL，就要把该条从 ✅ 降级、移进剩余缺口清单（`LANDING-PLAN.md` 第 1、4 节）——**不允许**带着 FAIL 进入阶段3。

---

## 为什么需要一次人工映射

判据逻辑是纯函数、已单测覆盖；但"插件的真实输出长什么样"在本会话不可观测。所以设计成：

| 层 | 谁负责 | 是否已在本会话验证 |
|---|---|---|
| **判定**（10 个 judge + 汇总） | `checks.mjs` | ✅ 33 项单测，含逐条反例 |
| **证据采集**（一次真实运行的观察结果） | 你，填进 trace | ❌ 依赖宿主插件真实输出 |
| **呈现 / 退出码** | `run.mjs` | ✅ 三种模式实跑（PASS / 拒判 / 缺文件） |

这套设计让"判定逻辑正确"与"数据真实"分开可查：**缺字段一律 FAIL，不会静默当成通过**。

---

## 用法

```powershell
cd docs\workflow-mode\verify
copy stage2-trace.template.json stage2-trace.json
# 用编辑器把 stage2-trace.json 里每个 null 换成真实观察值
node run.mjs --trace stage2-trace.json
```

退出码：`0` = 10/10 PASS ｜ `1` = 有 FAIL ｜ `2` = 用法/IO 错误（含"trace 没有 provenance，拒绝判定"）。

先看绿色长什么样（**故意用假数据，会警告并以 1 退出**）：
```powershell
node run.mjs --trace stage2-trace.example.json
```

不要猜插件的 JSON 结构，先探形：
```powershell
node run.mjs --probe ..\..\..\artifacts\flowchart.json
```
`--probe` 只读，打印受限的结构摘要（最多 40 键 / 3 层 / 只展开数组首元素），据此把真实键名映射进 trace。

---

## trace 各字段怎么填（对应 10 条判据）

| 字段 | 对应 | 怎么取得 | 通过判据 |
|---|---|---|---|
| `observedFrom.command` / `.date` | 出处 | 你实际跑的命令 + `YYYY-MM-DD` | **必填**，否则 run.mjs 拒绝判定（退出码 2） |
| `run.exitCode` | R1 | 那次运行的退出码 | `=0` |
| `run.stages[]` | R1 R2 | 解析出的流程图阶段 | 阶段数 `≥2`，且每个阶段有非空 `name` |
| `run.stages[].upstream[]` | R4 | 该阶段依赖的**阶段名**列表（根阶段给 `[]`） | 边数 `≥1`；无悬空引用；无自依赖；无环 |
| `run.subagents[]` | R5 | 本次运行创建的子代理 | 子代理数 `= 阶段数`，每个有非空 `id` |
| `run.subagents[].seesOtherSubagents[]` | R6 | 在该子代理**自己的上下文里**能看到的**其它**子代理 id | 每个都是 `[]`（跨引用总数 `=0`） |
| `run.stages[].preset` | R8 | 该阶段分配的预设模式 | 每阶段非空 |
| `run.artifacts[]` | R11 | 产物清单 `{path, kind:'result'\|'flowchart', bytes}` | 两类各 `≥1`，且所有产物 `bytes>0` |
| `library.emptyRun` | R13 | 清空库后跑一次的 `{exitCode, decision}` | `exitCode=0` 且 `decision='create'` |
| `library.secondRun` | R14 | **同一任务**二次运行的 `{reused, resplit}` | `reused=true` 且 `resplit=false` |
| `management.add/rename/delete` | R15 | 增（计数 before→after）/ 改名（旧名→新名 + `renamed`）/ 删（计数 before→after） | 增 `+1`；改名生效且名字变化；删 `-1` 且 `≥0` |

**R6 怎么取证**：在每个子代理的上下文里搜其它子代理的 id（或它们的独有标记），把搜到的写进 `seesOtherSubagents`。搜不到就是 `[]`。这是**唯一**能证明"不能直接交流"的方式——只看"有没有通信工具"不算。

---

## 判定语义的三处刻意选择

1. **缺字段 = FAIL，不是 SKIP**。隔离类要求一旦"没记录"就当通过，等于把 R6/R9 类安全要求变成默认放行。
2. **R4 要求 `edges ≥ 1`**。阶段间一条依赖都没有，说明"关联"根本没被解析，不能因为"没报错"就算过。
3. **R15 三项一起判**。"能删不能改"不是部分通过——需求写的是三件事都能做，`measured` 会一次列出全部违规项。

## 自测

```powershell
node checks.test.mjs
```
33 项：全绿基线 1 项 + 每条判据至少 1 个反例 + 空/null/垃圾输入不抛异常 + `summarize` 计数。
