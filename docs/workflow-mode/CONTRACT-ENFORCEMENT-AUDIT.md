# Workflow 工作模式 · 契约执行面审计

- **审计对象**：本机 `dsh-workflow-governance`（源：`local-plugins/dsh-workflow-governance/`；部署副本：`%APPDATA%\dsh-desktop\local-plugins\dsh-workflow-governance/`）
- **被审文本**：`presets/workflow/agent.cordis.yml` 的 persona（磁盘版），以及本次会话收到的协议文本（下称「新版协议」，它对部分条目已更诚实）
- **方法**：把每一条**可验证的宣称**映射到 `src/` 的实现行号。映射不上、或映射到相反行为的，记为不一致。不做推断式判定；每条都带文件与行号。
- **审计者立场**：只读源码。本报告不修改任何宿主配置。

---

## 0. 结论摘要

共 **24 处**宣称与实现不符（分解：契约关键字低报 1〔已修复〕· label/prompt 4 · 运行语义 6 · 门禁 7 · 死锁 2 · 预算 1 · 运行前提与产物形态 3），按危害排序，其中仍需优先处理的只剩两类（第三类已修复）：

| 类别 | 条目 | 为什么优先 |
| --- | --- | --- |
| **安全宣称不实** | 第 5 步的风险分级与「high 必须转人工」 | 这是一条**安全承诺**。实现里没有风险等级、没有自动批准、没有转人工，`gate_decide` 由同一个模型自己调用。读者会据此以为高危动作有人把关。 |
| **死开关** | 第 7 步的 `budget.maxWallClockMs` | 宣称「支持壁钟预算」，但该配置段在 `config.js` 里**不存在**，写进 `config.json` 不报错、不生效。宣称可用的熔断**永远无法启用**。 |
| ~~**低报能力**~~（✅ 已修复） | 第 2 步的契约关键字只有 8 个 | persona 已改为公布 24 个（见 §1）。此条仅作历史记录，勿再当现存风险引用。 |

另有 **2 处实现内部自相矛盾**（不是 persona 的错，但 persona 抄了错的那一边），以及 **1 处必须澄清的运行前提**（当前 `config.json` 下第 5 步门禁仍空转；结果产物已随 `resultArtifacts` 开启而落盘 `results/*.json`）。

---

## 1. 契约关键字：低报 16 个（第 2 步第 7 条）— ✅ 已修复（persona 现公布 24 个）

| 出处 | 公布/强制的关键字 |
| --- | --- |
| 新版协议第 2 步第 7 条 & `agent.cordis.yml:80-81` | **8 个**：`type` `properties` `required` `items` `minLength` `minItems` `additionalProperties` `enum` |
| `src/contract.js:17-42` 的 `ENFORCED` | **24 个**（上列 8 个 +）：`const` `minProperties` `maxProperties` `maxItems` `uniqueItems` `maxLength` `pattern` `minimum` `maximum` `exclusiveMinimum` `exclusiveMaximum` `multipleOf` `allOf` `anyOf` `oneOf` `not` |

- 未列出的关键字是**拒存**，不是忽略：`checkContractSupport()` 对每个未知关键字 push 一条 problem（`contract.js:95-98`），`validateWorkflow()` 把它汇总（`contract.js:366-368`），`library.save()` 直接拒绝（`library.js:153-154`）。所以「只用 8 个」的真实含义是：**操作者被要求放弃 16 个本来可用的约束**。
- 全部 24 个在 `validateValue()` 里都有对应执行分支（`contract.js:232-305`），并非常量摆设。
- 另有 9 个**注解类**关键字被允许但不约束：`$schema` `$id` `$comment` `title` `description` `default` `examples` `deprecated` `readOnly` `writeOnly`（`contract.js:45-56`）。**这一条 persona 完全没写**，操作者会以为 `title`/`description` 也会被拒绝。

**状态（已修复）**：persona 已按此建议改为「契约关键字（24 个）」的完整清单（见 `presets/workflow/agent.cordis.yml` 的「实现边界对照」节），不再有「8 个」的短名单。本表保留作历史记录——凡据此复读「协议只公布 8 个 vs 实现 24 个」的，都是过期结论，勿再引用。

---

## 2. `label`：协议说「必须」，实现是「建议」，而结构图根本不显示它

四种说法互不一致，persona 抄了其中错的那一种。

| 位置 | 说的是 |
| --- | --- |
| 新版协议第 2 步第 6 条 | 「每个 task 节点**必须**写 prompt 与 label」 |
| `contract.js:436-438`、`502-513` | 缺 `label` 只进 `advice`，`ok` 仍为 true，**不拒绝**。注释明确解释了原因：不想追溯性作废操作者已有的库。 |
| `contract.js:511` 的 advice 文案 | 「…so the structure diagram will show no role for them」——**这句是错的** |
| `diagram.js:53-60` `labelForNode()` | 只输出 `${id}\n${prompt 截断 60 字}`。**从不读 `node.label`**，没有第三行，也没有「未声明」这个字样。 |

也就是说：**即使写了 `label`，它也不会出现在任何图里。** persona 关于「label 是结构图方框第三行显示的内容，不写就显示未声明」的整段描述，在实现里没有任何对应物。
另外 `prompt` 同样**不被校验**：`validateWorkflow()` 只检查 `id`/`kind`/`waitPolicy`/边的 `when`，缺 `prompt` 完全合法；运行时由 `buildNodePrompt()` 兜底成一段通用指令（`plugin.js:487-494`）。

**建议**：persona 把 label 降级为「可选，仅供库里卡片与人工识别；当前版本不会渲染进结构图」，并删掉「第三行 / 未声明 / 必须」。若要图里显示角色，得同时改 `diagram.js`（读 label）与 `contract.js` 的 advice 文案——这是代码改动，不是文本改动。

---

## 3. 运行语义：五条宣称，实现里没有对应物

### 3.1 「并发槽 / 并行度 / 队列满则反压」（新版协议第 4 步、第 6 步）

实现是**严格串行**：

```js
for (const id of validated.order) {   // graph-run.js:78
  ...
  output = await spawn({ node, input, attempt, outEdges });  // graph-run.js:140
}
```

没有并发槽、没有并行度配置、没有队列、没有反压。节点按拓扑序**一个跑完再跑下一个**。「超出会排队/阻塞」描述的是不存在的调度器。

### 3.2 节点状态机 `PENDING → READY → RUNNING → VERIFYING → COMPLETED`（新版协议第 4 步②）

实现里**没有这个状态机**。`nodeResults[id].status` 只有两个取值：`DONE`（`graph-run.js:165`）与 `CONTRACT_VIOLATION`（`graph-run.js:173`）。事件类型是 `node-attempt` / `node-threw` / `node-done` / `node-output-rejected`（`graph-run.js:137,143,167,174`）。

那套状态枚举确实存在，但在**另一个模块**里：`deadlock.js:18-27` 的 `STATE` = `PENDING/READY/RUNNING/BLOCKED/DONE/FAILED/CANCELLED/SKIPPED`。它与 persona 写的**也不一样**：没有 `VERIFYING`，终态叫 `DONE` 不是 `COMPLETED`。而且该模块**没有被接线**（见第 5 节）。

### 3.3 decision 的「条件路由：只走命中的那条边」（新版协议第 6 步）

**运行时不存在分支选择。** `graph-run.js:78` 遍历 `validated.order`（**全部**节点），没有任何跳过逻辑；没有节点会读 `node.kind`。因此一个 `decision` 节点的**所有下游分支节点都会被 spawn**——只要它们能从起点到达。

`kind: decision` 买到的是**静态形状校验**（`contract.js:461-483`：出边 ≥2、契约两两不同、必须有一条默认分支），**不是运行期语义**。所以 persona 描述的三条 decision 规则里：形状校验是真，条件路由是假。

### 3.4 join 的 `all` barrier（新版协议第 2 步第 4 条、第 6 步）

`join` 的校验是真的（`contract.js:484-490`：入边 ≥2，`waitPolicy` 只接受 `all`，`any`/`n-of-m` 被拒绝而非忽略）。但**运行时没有 barrier 机制**：因为执行是串行拓扑序，轮到某节点时它的所有入边必然已产出。`all` 语义是拓扑序的**副产品**，不是实现出来的 barrier。

### 3.5 「上游 payload 不满足契约 → 该边不投递、该节点进入重试」（新版协议第 6 步）

实现是**整个运行立即中止**，且这条路径**实际不可达**：

- `graph-run.js:97-106`：任一入边契约不通过 → 直接 `return { status: 'BLOCKED_BY_CONTRACT' }`。没有重试、没有只跳过那一条边。
- 为什么不可达：上游只有在**它的全部出边**都通过校验后才会写入 `outputs[id]`（`graph-run.js:147-167`，`violations.length === 0` 才 `outputs[id] = output`）。下游的入边就是上游的出边，所以入边校验必然通过。`BLOCKED_BY_CONTRACT` 对合法 DAG 是**防御性死代码**。

真正会失败的路径只有一条，且方向相反：**产出不合格数据的那个节点自己被重跑**（`graph-run.js:136-181` 的 attempt 循环，`output` 违规 → 重跑**同一节点**）。注释称 "failure goes back upstream"，实际语义是「不合格的生产者重做」，这个说法成立，但「下游进入重试」不成立。

### 3.6 「只传契约内的 payload」

`graph-run.js:107` 是 `input[edge.from] = upstreamOutput` —— 传的是上游的**完整输出对象**，不是按边契约裁剪后的字段子集。`buildNodePrompt()` 把它整体 `JSON.stringify` 进 prompt（`plugin.js:517-519`）。Worker 因此能看到契约未声明的字段。

---

## 4. 门禁：一条不实的安全宣称（第 5 步）

这是本次审计最该修的一段。新版协议第 5 步正文写的是：

> 需要额外能力时必须提出 GrantRequest：plugin / scope / actions / reason / duration / **risk_level** …
> risk=low 自动批准、medium 由你批准、**high（写入/删除/外发/凭证）必须转人工** …
> Grant 为临时许可，**绑定节点**、带过期时间，**节点完成或到期立即回收** … 驳回可申诉一次，二次驳回即终局。

逐条对照 `gate.js`：

| 宣称 | 实现真相 | 行号 |
| --- | --- | --- |
| 风险分级 low/medium/high | **不存在**。`DENY` 枚举里没有任何风险概念，`decide()` 也不看风险 | `gate.js:12-23`, `166-202` |
| high 必须转人工 | **不存在**。`decide()` 由调用方（同一模型）调用，`by` 默认 `'main-agent'` | `gate.js:166`；`plugin.js:1011-1014` |
| GrantRequest 的 plugin/scope/actions/duration/risk_level | **不存在**。请求体只有 `capability` + `reason`，`reason` 为空则拒绝（这条是真的） | `gate.js:137-164` |
| 授权绑定节点 | **不存在**。grant 绑定的是 `agentId` + `capability` + `expiresAt` + `allowOnce`，没有节点概念 | `gate.js:189-198` |
| 节点完成即回收 | **不存在**。没有回收动作；grant 只是留在 Map 里等 `expiresAt` 过期后不可用 | `gate.js:216-222` |
| 到期立即回收 | 半真：到期后 `authorize()` 不再放行，但**没有回收**，条目一直留着 | `gate.js:217` |
| 驳回可申诉一次，二次即终局 | **不存在**。对已决定的请求再 `decide` 返回 `ALREADY_DECIDED`，没有申诉通道 | `gate.js:171-174` |
| 调用会被拦截并记审计 | 拦截是真的；**审计读不到**。`#audit` 只在内存（`gate.js:44`），没有任何工具 action 暴露它，重启即丢 | `gate.js:236-238`；`plugin.js` 全文无 audit action |

`requestAccess()` 拒绝理由**只有**：开关关、未知 agent、未知 capability、**理由为空**、已分配（`gate.js:141-148`）。「范围过大直接驳回」没有实现依据。

README 第 604-609 行自己承认了这个边界，原话是：`gate_decide` **cannot prove a human approved** … the approval is **asserted, then recorded**。**preset 的 persona 没有把这个边界带给读者**，反而把「必须转人工」写成了硬规则。

> **加重项**：新版协议第 5 步末尾的括注其实**已经承认**「工具的按节点分配与审计尚未实现」，但同一段正文照旧保留整套 risk/GrantRequest/绑定节点/申诉的规范性表述。读者会先接受硬性要求、再读到括注说这套不存在——**同一段里两个互斥的事实**。这正是本预设最该消除的自相矛盾。

---

## 5. 死锁检测：描述的是一个未接线的模块（第 7 步）

新版协议第 7 步：

> 死锁检测：全部节点 BLOCKED 且无 READY/RUNNING → 判全局停滞并处置

- 这是 `deadlock.js` 的 `detectDeadlock()` 语义（`deadlock.js:167-169`：`nonTerminal` 全部 `BLOCKED` 且 `running === 0`，或 `runnable === 0`）。
- 但 **`plugin.js` 没有 import `deadlock.js`**。它的 import 只有 `observe.js` 的 `createRunObserver` / `detectStall` / `explainStall` / `projectGraph`（`plugin.js:25`）。
- 开关 `switches.deadlockDetector` 实际启动的是 **`detectStall`（基于静默时长）**，针对的是**官方 `workflow` 工具启动的运行**（`plugin.js:1304-1355`），不是本层的图运行。
- 而且它的「处置」是**什么都不做**：达到 `escalateAfter` 次连续静默扫描后只 `note()` 一条日志（`plugin.js:1349-1352`）。README 第 69-70 行也写明：`It never cancels or disposes anything`。

所以这一条同时错了两处：**机制选错了模块，动作（处置）不存在**。另外本层的 `graph-run.js` 也从不产生 `BLOCKED` 状态，因此 `detectDeadlock` 即使被接线也没有数据源。

---

## 6. 预算：一个永远无法启用的死开关（第 7 步）

宣称（新版协议第 7 步 + README 第 460-464）：

> 本层支持**壁钟预算** budget.maxWallClockMs（默认 0 = 关闭）

- 读取端存在：`plugin.js:888` 读 `config?.budget?.maxWallClockMs ?? 0`。
- 执行端存在且正确：`graph-run.js:111-128`，检查在**每个节点 spawn 之前**；超过 80% 发 `budget-warning`，超过 100% 返回 `BUDGET_EXCEEDED` 并带 `stoppedAt` / `elapsedMs` / `maxWallClockMs`。
- **配置端不存在**：`config.js:62` 的 `SECTIONS` 是 `['switches','matcher','deadlock','gate','contracts','library','artifacts']` —— **没有 `budget`**。
- `mergeConfig()` 只遍历 `SECTIONS` 拷贝键（`config.js:148-160`），未知段被**丢弃**；`validateConfig()` 也只遍历 `SECTIONS`（`config.js:93`），未知段**不报错**。

后果：把 `"budget": {"maxWallClockMs": 60000}` 写进 `config.json`，**既不报错也不生效**，`config.budget` 永远是 `undefined` → `maxWallClockMs` 永远是 `0` → 预算永远关闭。这是一个**静默失效**的开关，比直接报错更糟。

**建议**：在 `config.js` 的 `SECTIONS` 与 `DEFAULT_CONFIG` 里加入 `budget: { maxWallClockMs: 0 }`，并给 `RANGE` 加一条非负校验。（这是代码改动。）

---

## 7. 当前 `config.json` 下的运行前提（必须让读者知道）

现有 `config.json` 的 `switches` 是：

```json
{ "switches": { "contracts": true, "templateLibrary": true, "deadlockDetector": true, "resultArtifacts": true } }
```

未列出的开关取默认 `false`。由此：

| 影响 | 依据 |
| --- | --- |
| **能力门禁整个空转**：`capabilityGate` 未开启 → `gate = null` → `gateRefusal()` 直接放行，永不拦截 | `plugin.js:759-761`, `109-110` |
| `gate_status` 会返回 `enabled: false`、`capabilities: []`；`gate_request` 返回 `GATE_DISABLED` | `plugin.js:1000-1013` |
| **结果产物已落盘**：`resultArtifacts` 已开启 → 每次运行写 `results/*.json`（含 graph/diagram/result） | `plugin.js:895` |
| 壁钟预算关闭（且如第 6 节，即使开启开关也无法配置） | `plugin.js:888` |
| `semanticMatcher` / `workflowMode` 关闭 | `config.js:9-22` |

也就是说，**第 5 步门禁在当前配置下仍空转**（`capabilityGate` 未开）；**结果产物已随 `resultArtifacts` 开启而落盘**。persona 把门禁写成了无条件流程，这一点仍成立。

顺带修正一处细节：产物文件名是 `${ISO时间戳去掉冒号点}-${stem}.json`，即形如 `2026-10-07T01-02-03-456Z-<stem>.json`（`artifacts.js:34-37`），`stem` 由 `artifactStem()` 清洗、上限 48 字符、空则回落 `workflow`（`artifacts.js:24-31`）。内联图只有在 `workflow.name` 存在时才有名字（`plugin.js:898`）。「形如 `2026-…-<图名>.json`」是宽松说法，落盘时应以实际形态为准。

---

## 8. 真确的宣称（核对通过，不要改）

为免修复时误伤，以下是**逐行核实为真**的部分：

| 宣称 | 依据 |
| --- | --- |
| 每条边必须有 `when`，无契约的边被拒存 | `contract.js:363-368`；`library.js:153-154` |
| 不支持的关键字是**拒存**而非忽略（fail-closed） | `contract.js:95-98`, `317-322`；`library.js:151-154` |
| 图合法性：恰好 1 个起点、≥1 个终点、全部可达、无孤立、无重复 id、无自环、**无环** | `contract.js:335-434` |
| decision：出边 ≥2、契约两两不同、必须有一条默认分支（不写 required、不写 properties、`additionalProperties !== false`） | `contract.js:461-483` |
| join：入边 ≥2；`waitPolicy` 只接受 `all`，其它**被拒**而非忽略 | `contract.js:484-490` |
| `kind: end` 不许有出边 | `contract.js:491-493` |
| 声明 `loop` 被拒并说明原因 | `contract.js:495-500` |
| 每个节点由**独立子代理**执行，跑完回收 | `plugin.js:605-665`；`graph-run.js:140` |
| Worker 之间不能直接交流（host 的 session 隔离） | 独立 subagent session |
| 产出违规 → 重跑该节点，≤ `maxAttemptsPerNode`（默认 2）→ 用尽即 FAILED | `graph-run.js:42,136-181,183-226` |
| DLQ 记录 `{fromNode,toNode,edge,reason,attempts,errors}`，卡片显示 `dlq N (上游→下游: 原因)` | `graph-run.js:189-196,209-216`；`plugin.js:312-315` |
| `OUTPUT_VIOLATES_CONTRACT` / `NODE_FAILED` / `INVALID_WORKFLOW` 带被判违规的**具体字段** | `graph-run.js:88-106,150-160,197-226`；`explainRun()` 237-261 |
| 预算的执行端：80% warning、100% `BUDGET_EXCEEDED` + `stoppedAt`/`elapsedMs` | `graph-run.js:111-128` |
| `save` 返回 `CREATED` / `REPLACED`，并 bump revision | `library.js:165,172` |
| **按 `name` 运行**自动记账 + 自动打分（内联图不记账） | `plugin.js:910-928`；打分公式 `plugin.js:253-265` |
| 不要再调 `record`（会重复计数） | `library.recordRun` 累加 `runs`（`library.js:200-239`）；README 第 511-517 |
| `record` 只用于本层没执行过的运行 | 同上 |
| 匹配阈值 reuse ≥0.80 / ask 0.60–0.80 / create <0.60 | `matcher.js:118-120`；`config.js:24-25` |
| 精确 name 命中直接 `reuse`（score 强制 1） | `matcher.js:167-174` |
| `query` 只接受 `name`/`text`/`task`/`labels`，未知键返回 `BAD_QUERY` | `plugin.js:48,58-74` |
| `report` 从不筛选，`query` 只加打分行 | `plugin.js:1024-1067` |
| 读取类动作（`list`/`get`/`find`/`diagram`/`export`/`observed`）不需要授权 | `plugin.js:44,996-999` |
| `NESTED_WORKFLOW_REFUSED`：Worker 内不能再开 workflow（按 host 的 `origin:'subagent'`/`parentSession` 判定）；**读库仍允许** | `plugin.js:89-101,848,991` |
| 节点 payload 裁剪到 600 字且**明确标注**截断总量，`full:true` 取全文 | `plugin.js:410-432` |
| `report` 的 `runs`/`ok` 会自己增长 | `library.js:200-239` |

---

## 9. 实现内部的两处自相矛盾（不是 persona 的错，但 persona 抄了错的一边）

1. **`label` 与结构图**：`contract.js:511` 的 advice 说缺 label 会让结构图不显示角色；`diagram.js:53-60` 根本不读 `label`。两个模块对同一件事的判断相反。
2. **README 自我否定**：同一份 README 里，第 434-443 行说 node `kind`（decision/join/end）、`loop` 拒绝、DLQ「**Enforced since the protocol landed**」；第 466-472 行又把这些列进「**Not implemented at all**」。前者与 `contract.js` 的实现一致，后者是过期段落。另外第 56-58 行曾说「the four-switch wording」〔已修复：现改为引用开关清单〕。

---

## 10. 建议的最小修复集（按性价比排序）

**只改文本（persona），不改代码：**

1. 契约关键字改为「以 `src/contract.js` 的 `ENFORCED` 为准，共 24 个」，并列出可用的与注解类两栏。
2. 删掉「label 是结构图第三行 / 不写显示未声明 / 必须写 label」。
3. 删掉「并发槽 / 并行度 / 队列 / 反压」，改为「本层按 DAG 拓扑序**串行**执行，一个节点跑完再跑下一个」。
4. 删掉节点状态机那行，改为「节点结果只有 `DONE` / `CONTRACT_VIOLATION` 两种；过程事件是 `node-attempt` / `node-threw` / `node-done` / `node-output-rejected`」。
5. 把「decision 条件路由」降级为「`kind` 只提供**静态形状校验**；运行期所有可达节点都会执行，分支选择需要你自己在 prompt 里做」。
6. 把 join 的 `all` 说成「拓扑序的自然结果」，而不是 barrier 机制。
7. 第 5 步整体降级：保留「能力名只有 `workflow:run` 与 `workflow:library:write`；请求体只有 capability + reason；理由为空则拒；`allowOnce` 一次性；TTL 默认 300000ms；读取类动作永不门禁；授权绑定的是 **agentId**，不绑定节点，也没有回收与申诉；`gate_decide` **无法证明是人类批准**」——并删掉 risk 分级、GrantRequest 字段清单、绑定节点、申诉。
8. 第 7 步死锁：改成「本层接线的是**静默检测**（`detectStall`），针对官方 `workflow` 工具启动的运行；达到 `escalateAfter` 次连续静默后**只写一条日志，不处置任何东西**」。
9. 第 7 步预算：加一句「`budget` 段当前**不在** `config.js` 的已知段里，写进 `config.json` 不报错也不生效；熔断执行端已实现但无法启用」。
10. 第 9 步结果产物：加条件「仅当 `switches.resultArtifacts` 开启；当前 `config.json` 未开启」。
11. 第 5 步门禁、第 9 步落盘两处都加「当前 `config.json` 下不会发生」。
12. 开头「你的执行工具只有两个」与 preset 组合矛盾：`agent.cordis.yml` 同时注册了 fs / fs-search / jobs / skill / todo / web / goal / pwsh / subagent 等一大批。改为「**编排手段**只有两个」。

**要改代码（超出本次审计授权的文本修正范围，需你决定）：**

13. `config.js`：把 `budget: { maxWallClockMs: 0 }` 加入 `DEFAULT_CONFIG` 与 `SECTIONS`，并加非负范围校验。「支持壁钟预算」只有在做了这一步之后才成立。
14. `contract.js:511` 的 advice 文案与 `diagram.js` 二者取一：要么让图读 `label`，要么改文案说 label 不进图。
15. `README.md` 第 466-472 行删除/改写，消除与第 434-443 行的互相否定；第 56-58 行的「四种开关」改为七种。
16. `plugin.js:1081` 的 `record` 不写 score（只传 `success`），而自动记账写 score（`plugin.js:912-916`）；若希望手动补记也进评分，需补 `score` 参数。

---

## 附：审计覆盖范围与未覆盖项

**已逐行核实**：`contract.js`(515) `graph-run.js`(261) `library.js`(308) `config.js`(209) `gate.js`(248) `plugin.js`(1420) `artifacts.js`(120) `diagram.js`(222) `matcher.js`(189) `deadlock.js`(276)。

**未逐行核实**（本报告不据其下结论）：`observe.js`、`engine-adapter.js`、`src/index.js`、`lib/index.js`、以及 `test/` 全部用例。凡涉及 `observed` 的行为，本报告只依据 `plugin.js:1095-1185` 的调用点；`projectGraph` 的内部实现未核。`test/` 声称 327 项通过（README 第 231-232），**本报告未运行测试**，该数字为引用而非复核（该缺口已在附录 B 补上）。

---

## 附录 B：真机实测（本机 · 2026-10-07）

审计是静态的（读代码）；这一节是**跑出来的**，用来区分"代码里像是对的"和"真的会这样发生"。
全部实验通过作者自己的 `contract_workflow` 工具在本机执行。

### B1 · 节点 `persona` 与 `toolFilter` 真的作用到子代理（对照实验）

一张两节点图：`restricted`（`toolFilter: {deny:["read","write","edit","glob","grep","pwsh"]}`）
→ `normal`（不限制），两者回答同一个问题：能否用 `read` 读 `C:\Windows\win.ini`。

| 节点 | `had_read_tool` | 说明 |
| --- | --- | --- |
| `restricted` | `false` | 被 deny，拿不到 read 工具 |
| `normal` | `true` | 读到真实首行 `; for 16-bit app support` |

并且 `restricted` 的输出里出现了 `"persona_marker":"PERSONA-OK"` —— 这个字段
**只写在节点的 `persona` 里，prompt 里一个字都没提**。所以 `persona` 确实作为该 Worker 的
独立系统人格生效，不是被丢掉。

**结论**：`SubagentStartRequest` 的 `persona` / `toolFilter` 不是摆设，
`plugin.js:618-628` 的透传是真的。这是「给每个子代理分配预设与工具」的机制基础。

### B2 · `toolFilter` 的工具名会被**硬校验**

第一次实验 deny 了 10 个名字，结果节点**在 spawn 之前**就失败：

```
NODE_FAILED · dlq 1 (restricted→?: NODE_FAILED) · upstream restricted
tools.restrict() names unknown global tools "bash","str_replace_editor","read_file","list_dir";
known global tools: ask_user_question, contract_workflow, ...
```

三点结论：① 宿主**真的执行** `tools.restrict()`；② 名字拼错是**硬失败**，不是静默忽略；
③ 重试与 DLQ 工作正常（两次 spawn 失败 → `dlq 1`），**且此时没有消耗任何子代理调用**。

> 实操提醒：写 `toolFilter` 前必须核对真实工具名。`cordis_inspect_query`
> （provider `Tool`、method `listTools`）能给全量清单，报错信息里也会附一份。

### B3 · `agentOptions` 真的用于模型路由

同一张两节点图，只改 start 节点的 `agentOptions.model`：

| `model` | 结果 |
| --- | --- |
| `no-such-model-xyz` | `NODE_FAILED` · `subagent run for node a ended abnormally (error)`，对照节点未执行 |
| `deepseek-flash`（真实存在） | `COMPLETED` · `a={"ok":true}` `b={"ok":true}` |

若 `agentOptions` 被忽略，两次都会正常完成。所以它**被读取并使用了**。

### B4 · 入库会**完整保留**这些字段

`save` 一个带 `persona` / `toolFilter` 的图后，直接读库文件核对：

```
library.json:1086:  "persona": "你是受限执行者：…"
library.json:1087:  "toolFilter": {
```

`plugin.js:871-880` 的按名运行是 `workflow = { nodes: entry.nodes, edges: entry.edges }`，
与内联图同构，所以**按 `name` 跑已存的图时 persona / toolFilter 同样生效**。
（探针图已 `REMOVED`，没有留在库里。）

### B5 · 本层**没有**透传 `outputSchema` / `maxDepth`

宿主 `SubagentStartRequest` 声明了这两个字段，但 `plugin.js:618-628` 只透传
`agentOptions` / `toolFilter` / `persona`。所以节点上写 `outputSchema` 或 `maxDepth` **无效**。

**这是一个可改进点**：`outputSchema` 能让节点直接产出结构化输出，比在 prompt 里写
"请返回 JSON" 可靠得多 —— 而 `parseNodeOutput()`（`plugin.js:550-587`）目前要靠
"整段是 JSON / ```json 围栏 / 首尾括号截取"三重猜测才能拿到对象；正是 `{text}` 兜底
把一次真实运行送进 DLQ 的成因（`plugin.js:468-476` 的注释记录了那次事故）。

### B6 · 测试基线（把"引用"升级为"复核"）

`node test/<file>.test.mjs` 逐个直接运行（`node --test` 在本沙箱会因 spawn 受限）：

| 文件 | pass | 文件 | pass |
| --- | --- | --- | --- |
| bundle | 7 | gate | 19 |
| contract | 24 | artifacts | 12 |
| graph-run | 19 | deadlock | 21 |
| library | 25 | observe | 26 |
| matcher | 17 | adapter | 21 |
| diagram | 24 | plugin | 99 |
| config | 13 | | |

**合计 327 项、0 失败**，与 README 第 231-232 行声称的数字一致 —— 该数字由此从
"引用"变为"已复核"。另外 `examples/demo.mjs` → `DEMO OK`；`examples/smoke.mjs` → `SMOKE OK`。

改写 preset 之后 `bundle.test.mjs` 仍然 **7/7** 通过（R16 结构测试要求 persona 必须真的
教会 `contract_workflow` / `when` / `find` / `observed` / `gate_request` / `inferred`
六项机制，并禁止绕过契约）。
