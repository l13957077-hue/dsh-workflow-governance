# 官方工作流能力 seam：从已装宿主提取的真实签名

**这份文档不是推测**，是从本机运行中的 DSH 宿主里读出来的。

| 项 | 值 |
| --- | --- |
| 宿主 | `<DSH install dir>\DSH Desktop.exe`（4 个进程在跑） |
| 代码位置 | `…\DSH Desktop\resources\app.asar` |
| 包版本 | 全部 `@deepseek-ai/*` = **`0.2.0-rc.2`**（不是 npm 上的 `0.0.1-rc.1`） |
| 提取脚本（只读） | `recon-workflow-seam.py`、`recon-workflow-dump.py` |
| 产物 | `recon-workflow-seam.txt`、`recon-workflow/<pkg>/…` |
| 复现 | `python recon-workflow-seam.py && python recon-workflow-dump.py` |

**一个提取上的坑**：asar 的 `exports` 指向 `./lib/types/*.d.ts`，但打包时**`.d.ts` 被剥掉了**（inventory 里只有 `lib/*.js`）。所以下面的签名来自 `lib/*.js` 源码与随包 README，不是类型声明。

---

## 1. 服务名纠正：是 `ctx.workflowEngine`，不是 `ctx.workflows`

```js
var WorkflowEngine = class extends Service {
    constructor(ctx) {
        super(ctx, "workflowEngine");
    }
    emitWorkflowEvent(name, ...args) { /* 隔离每个监听器的异常 */ }
};
```

这就是自动扫描「找不到 `workflows` 注册证据」的原因——**服务名字符串是 `workflowEngine`**。

一个 ctx 只能有一个引擎：**加载第二个引擎会明确报错**，所以更换执行引擎 = 更换组合里加载的引擎插件。

## 2. 编程入口（唯一的启动面）

```js
ctx.workflowEngine.start({ script, meta, args?, parent, signal?, subagentProvider?, maxTotalAgents? })
```

返回的 run 句柄：`{ id, meta, result, cancel(reason?), dispose() }`

| 性质 | 细节 |
| --- | --- |
| 校验时机 | `start()` 在 run 存在**之前**校验 meta 块并解析脚本 → 畸形请求同步失败，附违规清单 |
| `result` | **永不 reject**：脚本失败兑现 `stopReason:'error'`，取消兑现 `'cancelled'` |
| 归属 | **持有方负责**：每条路径都要 `dispose()`；`dispose()` 会取消剩余工作并等待脚本与子代理清理 |
| `parent` | 把每个子代理归属于调用它的 agent |
| `signal` | 中止时取消运行 |
| 引擎卸载 | 阻止**新的**启动，但**不撤销**已接受的运行；服务**不跟踪**活动 run（没有注册表） |
| 收集模式 | **仅前台**。seam 层没有后台启动/轮询、spill 句柄、分离收集 |

## 3. 脚本钩子（模型写的脚本体里可用）

| 钩子 | 语义 |
| --- | --- |
| `agent(prompt, opts)` | 启动一个子代理；以最终文本兑现，或在提供 schema 时以**校验过的结构化值**兑现。**普通子代理失败兑现 `null`**（不是异常） |
| `parallel([...])` / `pipeline([...])` | 组合独立工作；**致命错误会重新抛出**，不会把条目映射成 `null` |
| `phase(title)` | 向观察者叙述当前阶段 |
| `log(message)` | 向观察者叙述一行 |

脚本是**纯 JavaScript 脚本体**（非 TypeScript），顶层 `await` 可用，以 `return <json-value>` 结束。`meta` 与 `args` 只作为 **JSON 数据**到达，**绝不作为代码求值**。

错误分类：`WorkflowError extends HarnessError`，带机器可路由的 `code` 与 `fatal` 标志；`isFatalWorkflowError(error)` 用宿主侧 `instanceof` 判定（**脚本 realm 无法伪造**）。

## 4. `workflow/*` 事件：6 个，**观察专用**

| 事件 | 载荷 | 不变式（由 `workflow-invariant` 强制） |
| --- | --- | --- |
| `workflow/start` | `(info)`，`info = { id, meta: { name, description, … } }` | `id` 非空且**未重复**；`meta.name`、`meta.description` 非空 |
| `workflow/phase` | `(info, title)` | `title` 作为阶段标题使用 |
| `workflow/log` | `(info, message)` | — |
| `workflow/agent-start` | `(info, agent)`，`agent = { seq, childId, label, phase }` | `seq` 为**正整数且在该 run 内唯一**；`childId` 非空 |
| `workflow/agent-end` | `(info, agent)`，多一个 `outcome` | 必须存在同 `seq` 的 start；`label` / `phase` / `childId` **必须与 start 一致**；`outcome ∈ {completed, failed, cancelled}` |
| `workflow/end` | `(info, result)`，`result = { agentsStarted, stopReason, error? }` | 不得有**未配对**的 agent start；`agentsStarted` 为安全整数且覆盖所有已观察 start；`error` **恰好当 `stopReason === 'completed'` 时缺席** |

**关键安全性质（这就是被冻结的 WorkflowApi）**：所有 6 个事件的 `info` 都是**运行身份快照**，而且不变式要求每个事件的 `meta` 与 `workflow/start` 的 `meta` **逐字节一致**（`JSON.stringify` 比较）。载荷**绝不携带活动 run**，因此**监听器无法取得 cancel 或 dispose 权限**。每个监听器还会收到**自己的载荷副本**，抛错的监听器只记日志、不会饿死同级或改变执行。

监听方式（跨作用域要 `{ global: true }`）：

```js
ctx.on('workflow/agent-end', (info, agent) => { … });
ctx.on('internal/dispatch', (mode, eventName, args) => { … }, { global: true });
```

引擎侧发射用 `engine.emitWorkflowEvent(name, ...args)`。不变式伴生入口：插件名 `workflow-invariant`，`inject: ['invariants']`。

## 5. `dsh-tool-workflow`：模型侧工具 + 4 个只读会话记录事件

- 工具参数：`meta{name, description, whenToUse?, phases?}`、`script`、`args?`、`run_in_background?`
- 返回：前台 `{ kind:'foreground', runId, agentsStarted, result }`；后台 `{ kind:'background', jobId, runId }`
- 配置：`toolName`(`workflow`)、`maxResultChars`(`50000`)、`enableRunInBackground`(`true`)
- **模型只看到最终结果，永远看不到中间子代理消息**；父级轮次会阻塞到整个工作流结算
- 会话记录：4 个 **log-only** 事件（run-start / member-start / member-end / run-end）
  - **只对 root transport 执行写记录**（`exec.parent` 缺省）；嵌套调用照常执行但**不写任何记录**
  - 会话追加**首次失败后停止记录**并只告警一次，留下空记录或合法连续前缀，**不改变工具结果**

## 6. `dsh-client-ui-workflow-run`：运行节点（Web）

把每个持久化的**顶层**运行渲染为一个**独立 Chat 节点**：展开 run → 看 phases → 展开 phase → 看 members。运行中/失败/取消/已中断默认展开，已完成保持折叠。

打开成员子会话的条件：**成员与子级都在运行**，且子级属于当前 Session 的**直接子级目录**。

**节点只显示身份与状态**——脚本、输出、错误、日志、用量、静态拓扑、控制操作**都不属于这个界面**。

装配方式（这是新增 UI 面要照抄的模式）：Definition + locale 字典 + keyed `workflow-run` renderer，**三者都由 Cordis effect 持有**，移除 client entry 会撤销三者。

## 7. 执行引擎 `dsh-workflow-ptc` 与隔离真相

在调用 Session 的文件沙箱策略下、**全新 Node 进程**中执行。

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `provider` | `spawn` | `agent()` 使用的宿主侧子代理提供方 |
| `maxConcurrentAgents` | `0` | 并发上限；`0` = 按可用 CPU 解析 |
| `maxTotalAgents` | `1000` | 单次运行最多 `agent()` 调用数 |
| `maxItemsPerCall` | `4096` | 单次 `parallel()`/`pipeline()` 条目数 |
| `syncTimeoutMs` | `5000` | 初始同步片段的 VM 超时 |

**必须写进威胁模型的官方自述**：

- 上限是**协作式**的，**不是 Host 强制安全配额**，也不是后代 token 预算
- **VM 不是安全边界**；触达 Node 的代码受所选 OS 文件策略约束
- **文件策略不限制网络访问**
- 程序可见的环境为空
- 工作流向 PTC 请求 `timeoutMs: null` → **没有整体经过时间截止**
- 取消立即中止 PTC 进程与待启动/活跃子代理
- 加载时拒绝非 TypeScript 的 PTC 提供方；Python PTC 组合必须禁用 `workflow-ptc`、`tool-workflow` 及任何已启用的 `tool-ralph`

---

## 8. 官方自述限制——**直接推翻需求基线的"插件已有"假设**

| 官方限制（原文） | 冲击 | 涉及需求 |
| --- | --- | --- |
| **「没有已保存或嵌套工作流」**：只启动调用方提供的脚本，脚本**不收到** `workflow()` 递归钩子 | **没有模板库、没有已存流程图、没有按图复用** | R11 的"全套流程图"落盘、R12、R13、R14、R15 |
| **「没有日志化或恢复」**：脚本、子代理进度、中间值**均不设检查点**，进程重启后**无法继续** | **没有断点续跑** | 基线把"断点续跑"列为"插件已有、不要做" → **官方无此能力** |
| **「没有 token 预算词汇」**：只限并发/条目/子代理数，**不计 token** | 预算熔断必须靠 `dsh-budget` 或自研 | D7 |
| **「运行由持有方负责，不由服务跟踪」**：无活动 run 注册表 | 无法枚举或中断别人启动的运行 | D5 治理面设计 |
| 前台收集 only（seam 层） | seam 层无后台启动/轮询 | R16 的长时运行考虑 |

**结论**：基线里"断点续跑、持久化、增删改名 插件都已有，不要做"这条对**官方能力不成立**。这些能力只能来自第三方插件（`omdsh-dev/dsh_workflow` 等）或自研；而第三方插件**本会话无法核验**（未打包进宿主 asar、shell 无网）。

---

## 9. 这对 D5（R16 / R17）意味着什么

**不再需要自定义 `HostSessionApi`。** D5 建在已确认的 seam 上：

| 需要 | 用什么 |
| --- | --- |
| 启动运行 | `ctx.workflowEngine.start({ script, meta, args?, parent, signal? })` |
| 观测 | `ctx.on('workflow/start' \| 'phase' \| 'log' \| 'agent-start' \| 'agent-end' \| 'end')` |
| 取消 / 清理 | **只能**通过自己持有的 run 句柄 `cancel()` / `dispose()`——事件层拿不到控制权（这是设计保证，不是约定） |
| 新增 UI 面 | 照抄 `dsh-client-ui-workflow-run` 的模式（Definition + keyed renderer + locale 字典，全部由 Cordis effect 持有），注册**新的**节点/视图，**不改动它** |
| 版本对齐 | 对齐**已装的 `0.2.0-rc.2`**，不是 npm 上的 `0.0.1-rc.1` |

**官方仍未满足 R16/R17 的部分**（都要宿主侧独立包装层做）：

1. 与工作区**平行**的独立模式——官方运行节点只是**既有会话内的一种 Chat 节点**，不是平行模式
2. 模式内会话与工作区会话**列表隔离**
3. 可搜索 / 可加文件夹 / 可换视图 的独立视图

## 10. 命名冲突警告（装错包的高风险点）

| 包 | 归属 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-workflow` | **官方**（scoped） | 本节文档描述的就是它 |
| `dsh-workflow@0.1.0` | **第三方**（unscoped，repo `dushaobindoudou/dsh-plugin`） | Workflow Studio |

**同名不同包**。任何引用都必须写全 scope，否则极易装错。

## 11. 未能核验的两件事（诚实清单）

1. **`dsh-workflow`（Workflow Studio，第三方）与 0.2.0-rc.2 是否兼容 → 未核验。** 它没被打包进宿主 asar，shell 又无网。只做得了静态判断：它声称「以 workflow mode 启动会话」，而**官方 seam 没有"模式"概念**，因此它多半自带一套会话启动面——与 0.2.0-rc.2 之间存在 API 漂移风险。要定论必须在能联网的宿主上实测。
2. **npm 的 `@deepseek-ai/dsh-workflow@0.0.1-rc.1` 与已装 `0.2.0-rc.2` 的差异 → 无法比对。** 只能以**已装版本为准**，D5 必须按 0.2.0-rc.2 的签名写。
