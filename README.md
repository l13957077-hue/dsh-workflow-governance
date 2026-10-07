# dsh-workflow-governance

> **DSH 声明式工作流治理层** —— 把「任务自动拆分 → 生成 DAG → 子代理隔离执行 → 契约校验 → 结果落盘 → 模板复用」做成一套可安装、可开关、默认完全惰性的宿主侧插件。

![tests](https://img.shields.io/badge/tests-327%20passing-brightgreen)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

---

## 目录

- [项目简介](#项目简介)
- [功能说明](#功能说明)
- [核心 Workflow 机制](#核心-workflow-机制)
- [安装步骤](#安装步骤)
- [使用教程](#使用教程)
- [已知限制](#已知限制)
- [更新日志](#更新日志)
- [开发与测试](#开发与测试)
- [许可](#许可)

---

## 项目简介

`dsh-workflow-governance` 是 DSH（DeepSeek Harness）的**宿主侧工作流治理层**。

DSH 自带一个 `workflow` 工具，但它执行的是**模型自己写的脚本**：脚本里跨节点的 `agent()` 调用**不经过任何声明式契约**，而且引擎独占那个 VM，外部无法拦截。这个仓库补上的正是这一层——它自己拥有整张图：

- 每条边都带 **JSON Schema 数据契约**（`when`），节点 spawn **之前和之后**都校验；
- 违约不是"忽略"，而是**退回上游重做**；
- 本层无法强制执行的契约写法（`$ref`、`if/then/else`、`format` …）**直接拒存**，绝不悄悄降级成"无约束"。

设计原则是**加法 + 惰性**：它从不 insert/replace 官方的 `@deepseek-ai/dsh-workflow`（workflow 接缝每个 context 只允许一个 engine，第二个注册会抛错），也不禁用任何原生能力；每个功能一个开关，**默认全关**——装上它和没装它没有区别，直到你显式开启。

本工程完整覆盖一块自定义 workflow 工作模式所需的六件事：

1. **任务自动拆分** —— 主控把任务拆成若干阶段并生成图；
2. **生成 DAG 流程图** —— 节点/边模型，每条边带数据契约，`save` 时做图合法性校验；
3. **子代理独立隔离** —— 每个节点一个独立 subagent，节点之间只按边传数据；
4. **子代理插件权限申请机制** —— 未授权的能力必须带理由申请，批准后才放行；
5. **流程图模板保存 / 管理** —— 文件系统模板库，先查后建，带使用统计与评分；
6. **和工作区对话相互独立** —— 库、历史、产物都是插件自己的存储，不写宿主全局状态。

## 功能说明

| 模块 | 能力 | 落点 |
| --- | --- | --- |
| 契约执行 | 边级数据契约；spawn 前校验入边、spawn 后校验出边；违约退回上游重做 | `src/contract.js`、`src/graph-run.js`、工具 `contract_workflow` |
| 图合法性 | `save` 时**真拒绝**：恰好 1 个 start、≥1 个 end、全可达、无孤立/重复 id/自环、**禁环**、每条边必须 `when`、关键字白名单 | `src/contract.js` |
| 子代理隔离 | 每个 task 节点一个独立 `subagent`（跑完回收）；节点间**不共享对话**，只能按边传被校验过的 JSON | `src/plugin.js` |
| 节点级预设/工具/模型 | `persona`（预设人格）、`toolFilter`（工具白名单/黑名单，宿主真拦截）、`agentOptions`（provider/model/reasoningEffort） | `src/plugin.js` |
| 模板库（先查后建） | 文件系统存储、CRUD、`find` 打分（`reuse` ≥ 0.8 / `ask` 0.6–0.8 / `create`）、运行历史与自动评分、export/import、Mermaid 渲染 | `src/library.js`、`src/matcher.js`、工具 `contract_workflow_library` |
| 结果落盘 | 每次运行写 `results/*.json`（设计图 + Mermaid + 执行结果 + 问题/死信） | `src/artifacts.js` |
| 死锁 / 停滞观测 | 订阅 `workflow/*` 事件，报告静默运行（**只观测，从不 cancel**） | `src/deadlock.js`、`src/observe.js` |
| 能力门禁 | 子代理之间的动态能力授权（实验性，默认关） | `src/gate.js` |
| 官方接缝适配 | 对 `ctx.workflowEngine` 的具体适配器 | `src/engine-adapter.js` |

## 核心 Workflow 机制

### 1. 图模型：节点 + 边 + 契约

```json
{
  "nodes": [
    {
      "id": "collect",
      "prompt": "采集素材",
      "toolFilter": { "allow": ["read", "glob", "grep"] }
    },
    {
      "id": "review",
      "prompt": "独立复核",
      "persona": "你是带着怀疑去核查的复核者",
      "agentOptions": { "model": "deepseek-flash" }
    }
  ],
  "edges": [
    {
      "from": "collect",
      "to": "review",
      "when": {
        "type": "object",
        "required": ["items"],
        "properties": {
          "items": { "type": "array", "minItems": 1, "items": { "type": "string" } }
        },
        "additionalProperties": false
      }
    }
  ]
}
```

### 2. 执行时序

```text
save  → validateWorkflow()：不合法的图直接拒存（不是提醒）
run   → 按拓扑序逐个节点：
         ① 入边契约校验   不满足 → 该节点不 spawn（BLOCKED_BY_CONTRACT）
         ② spawn 独立 subagent（带该节点的 persona / toolFilter / agentOptions）
         ③ 出边契约校验   不满足 → 退回上游重做，≤ maxAttemptsPerNode（默认 2）
         ④ 仍不满足 → 记 DLQ，节点判 OUTPUT_VIOLATES_CONTRACT
      → 全部完成 → 写 results/*.json → 回写模板库统计与评分
```

### 3. 子代理独立隔离

每个节点跑在自己的 subagent 里，**节点之间不共享对话、不共享中间产物**。上游给下游的唯一通道，就是边上那段**被契约校验过**的 JSON；下游看不到上游的思考过程，也看不到其它节点的输入输出。

### 4. 权限申请机制（能力门禁）

子代理默认只看得到工具目录；要额外能力必须**提出理由**向主控申请（`gate_request`，带 capability + reason），主控批准后才放行；许可是临时的、带 TTL，用完回收。

> ⚠️ 这一条目前是**实验性**的：门禁只覆盖两个能力（`workflow:run` / `workflow:library:write`），默认关闭。详见[已知限制](#已知限制)。

### 5. 流程图模板库：先查后建

```text
find(task) → reuse（≥0.80）  直接加载该模板执行，禁止重新设计
           → ask（0.60–0.80） 询问用户是否复用
           → create（<0.60）  新建 → save 过校验后入库
```

每次按名字运行会自动记一次 history 并打分；`report` 可看使用统计。

### 6. 与工作区对话相互独立

模板库、运行历史、结果产物都是**插件自己的存储**（`library/`、`results/`），不写 DSH 全局状态；默认禁止 Worker 内嵌套再开 workflow。整个模式与主工作区对话独立。

## 安装步骤

### 前置

- DSH Desktop（本仓库在 `0.2.0-rc.2` 上验证）
- Node.js ≥ 20（**仅测试用**；运行时不需要装依赖，本包 `dependencies` 为空）

### 安装

```powershell
dsh plugin --profile web add link:<你的路径>\dsh-workflow-governance
```

仓库自带 `cordis.patch.yml`，**只插入一行**，不做任何替换或禁用：

```yaml
- insert:
    - id: workflow-governance
      name: 'dsh-workflow-governance'
```

### 启用

装上之后**默认完全惰性**（没有 `config.json` 时全部开关为 `false`）。把示例配置复制一份放好，按需开关：

```powershell
Copy-Item config.example.json config.json
```

`library.root` / `artifacts.root` 写相对路径时会**相对插件目录**解析，所以示例用相对路径，换机器不用改。

## 使用教程

### 1. 直接在对话里用

```text
用 workflow 帮我做：先采集 X，再独立复核，最后汇总。
```

主控会先 `find` 模板库；没有合适的就生成一张图、`save` 过校验、然后按图执行。

### 2. 直接调工具

**`contract_workflow`** —— 按图执行（inline 定义或按名字）：

```text
contract_workflow { name: "整理周报" }
```

**`contract_workflow_library`** —— 模板库管理：

| action | 作用 |
| --- | --- |
| `list` / `get` | 只读；`get` 会带出节点与边契约 |
| `find` | 按任务打分，返回 `reuse` / `ask` / `create` |
| `save` | **先校验**，不合法直接拒 |
| `rename` / `remove` | 改名 / 删除 |
| `record` | 手动记一次运行（按 name 跑时**会自动记**，别重复调） |
| `export` / `import` | JSON 往返 |
| `diagram` | 渲染 Mermaid |
| `report` | 使用统计与历史 |
| `observed` / `gate_*` | 观测与门禁（实验性） |

### 3. 一次完整流程

```text
① contract_workflow_library { action: "find", query: { task: "整理周报" } }
② 命中 → contract_workflow { name: "整理周报" }
   未命中 → 自己写图 → { action: "save", definition: {...} } → { name: "..." }
③ 跑完看 results/<时间戳>-<图名>.json
④ contract_workflow_library { action: "report" } 看统计与历史
```

## 已知限制

这些是本层的**诚实边界**——写在这里，是为了让你不要按做不到的预期用它：

| 限制 | 说明 |
| --- | --- |
| **串行执行** | 没有并发槽 / 并行度，节点按拓扑序一个接一个跑 |
| **无消息层** | 没有消息信封、ACK、重发、幂等去重、DLQ 队列——"投递"就是一次进程内函数调用 |
| **节点状态机极简** | 只有 `DONE` / `CONTRACT_VIOLATION`，没有 `PENDING→READY→RUNNING→VERIFYING→COMPLETED` 全状态机 |
| **无条件路由** | `decision` 只在 save 时做形状校验；运行时所有可达节点都会执行 |
| **join 只支持 `all`** | `any` / `n-of-m` 会被拒 |
| **禁环** | 任何环都被拒（声明 `loop` 也被拒）；要迭代请拆成多轮 |
| **契约关键字 24 个** | 白名单外（`$ref`、`patternProperties`、`if/then/else`、`format`…）直接拒存 |
| **匹配是词袋，不是语义向量** | `matcher.js` 是 hash bag-of-words + Jaccard/cosine：换个说法可能判 `create`（实测「整理周报」= 1.0，「把本周活动整理成一份周报」= 0.23）。要复用请优先给 `query.name` |
| **门禁是实验性** | `capabilityGate` 只覆盖两个能力且默认关闭；`gate_decide` 无法证明"人工批准" |
| **无 designed/executed 分离、无 WAL** | 设计与执行结果在同一份 `results/*.json` 里 |
| **无预算熔断** | `budget` 段未接线，写进 config 也不生效 |
| **无 pause / resume / cancel** | 一次运行是一个同步工具调用，没有句柄 |
| **产物在 `results/`** | 没有 `delivery/` 交付区 |

更多细节见 [`docs/workflow-mode/CONTRACT-ENFORCEMENT-AUDIT.md`](docs/workflow-mode/CONTRACT-ENFORCEMENT-AUDIT.md)（宣称 vs 实现逐条对账）与 [`docs/PLUGIN-INTERNALS.md`](docs/PLUGIN-INTERNALS.md)。

## 更新日志

### v0.2.0

- **完整的边级数据契约执行**：spawn 前入边校验 + spawn 后出边校验 + 违约退回上游（≤ `maxAttemptsPerNode`）+ DLQ 记录
- **模板库**（保存 / 管理 / 复用）：文件系统存储、CRUD、`find` 打分、运行历史与自动评分、export/import、Mermaid
- **节点级 persona / toolFilter / agentOptions**：每个子代理的预设人格、工具白名单、模型与推理强度，均已实测生效
- **结果落盘**：每次运行写 `results/*.json`（设计图 + Mermaid + 执行结果 + 问题/死信）
- **死锁 / 停滞观测**：订阅 `workflow/*` 事件（只观测，从不 cancel）
- **契约审计**：`docs/workflow-mode/CONTRACT-ENFORCEMENT-AUDIT.md` 逐条对账
- **文档漂移守卫**：`docs/workflow-mode/check-doc-drift.ps1`，把"开关清单漂移"做成可执行断言
- **测试：327 项**（13 个测试文件）

### v0.1.0

- 初始骨架：开关配置体系、`diagram`、`matcher`、`deadlock`、`gate`、`engine-adapter`、`observe`

## 开发与测试

```bash
node --test test/          # 全部测试（327 项）
node examples/demo.mjs     # 端到端示例
node examples/smoke.mjs    # 冒烟测试
```

零运行时依赖（`dependencies` 为空）。`@deepseek-ai/dsh-tools` 通过**宿主的解析路径动态导入**，刻意**不声明为依赖**——物理副本的工具分发 Symbol 与宿主 bundle 不同，会让每次工具调用读到 `undefined`。

## 许可

[MIT](LICENSE)
