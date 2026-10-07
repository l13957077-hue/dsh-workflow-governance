# 阶段2 探针：宿主端一次跑完

把「这个 build 到底有哪些服务」「候选第三方插件能不能用」两个问题变成**可复现、可门禁**的命令，而不是一次性的手工挖掘。

## 0. 探针回答什么

| 问题 | 命令 | 判据 |
| --- | --- | --- |
| 本 build 注册了哪些 cordis 服务？ | `python probe-services.py` | 打印全部服务名 + 注册者 + 各插件 `inject` 列表 |
| `workflowEngine` 存在吗？ | `python probe-services.py --require workflowEngine` | **exit 0** = 存在；exit 1 = 不存在，**不要对着它写代码** |
| 候选插件能否静态判定可用？ | `python probe-plugin-compat.py --plugin <dir>` | exit 0 = 无静态阻塞；exit 1 = 有阻塞 |
| 阶段2 的 7 条 CORE 是否成立？ | `node verify\run.mjs --trace verify\stage2-trace.json` | CORE 7/7 PASS |
| 安装前坐标与 pin 是否可信？ | `.\preflight.ps1 -Profile web` | 6 行全 GO |

## 1. 离线部分（不需要网络）

```powershell
cd docs\workflow-mode

# 服务清单 + 必需服务门禁
python probe-services.py --require workflowEngine --require subagents --require tools

# 阶段2 判定（需先按 verify\README.md 填一次 stage2-trace.json）
node verify\run.mjs --trace verify\stage2-trace.json
```

产物：`probe-services.json`（机器可读，供兼容性探针消费）、`probe-services.txt`（人读）。
两者都在 `.gitignore` 里——它们含本机 asar 的绝对路径。

**升级 DSH 之后重跑这一条**：服务名一旦变化，D5 的 `inject` 列表就必须跟着改。这正是当年把 `ctx.workflows` 猜错的那个问题。

## 2. 需要网络：候选第三方插件兼容性

```powershell
npm pack dsh-workflow@0.1.0
tar -xzf dsh-workflow-0.1.0.tgz
python probe-plugin-compat.py --plugin .\package --name "dsh-workflow@0.1.0"
```

它检查四件事：

| # | 检查 | 阻塞？ |
| --- | --- | --- |
| 1 | 声明的 `@deepseek-ai/*` 依赖版本 vs 本 build 实装版本 | 缺包=阻塞；版本漂移=风险 |
| 2 | 它的 `inject` 名单里的服务，本 build 是否注册 | **缺失=阻塞** |
| 3 | 它**注册**的服务名是否与本 build 已有服务重名 | 风险（`workflowEngine` 会附上专门说明） |
| 4 | `dsh.client.inject` 的 UI 服务是否存在 | 缺失=阻塞 |

**三种判定已用 fixture 实测**（见 `probe-fixtures/`）：

```
已知良好（官方 dsh-tool-workflow）  -> STATIC-OK        exit 0
重名（官方 dsh-workflow 本体）      -> STATIC-RISK      exit 0
合成坏插件（bad-plugin）            -> STATIC-BLOCKER   exit 1
```

**注意 `workflowEngine` 的重名含义**：官方 seam 规定**一个 context 只能有一个引擎，加载第二个会明确报错**。所以候选插件若也注册 `workflowEngine`，它不是"可以并存"，而是要么替换官方 `dsh-workflow`（须在组合里顶掉它），要么装不上。探针会把这句话打出来。

**精度声明**：这是**静态分析**。它能证明"有阻塞"，**不能证明"兼容"**。真正的结论只有在真实宿主里加载一次才能得到——而且那次加载必须可回滚（见 `HOST-INSTALL-CHECKLIST.md` 第 5 节）。

## 3. 本机实测结论（DSH Desktop，`@deepseek-ai/*` 全为 `0.2.0-rc.2`）

| 项 | 结果 |
| --- | --- |
| 已装 `@deepseek-ai/*` 包数 | 289 |
| 注册的 cordis 服务名 | **125** |
| `workflowEngine` | **YES** ← `dsh-workflow/lib/index.js#WorkflowEngine`（`lib/types/index.js` 同） |
| `workflows` | **no**（服务名不是它——这就是当初猜错的地方） |
| `events` | **no**（`ctx.events` 是 cordis 自带的，不是 `@deepseek-ai/*` 注册的服务） |
| `subagents` | YES ← `dsh-subagent/lib/index.js#SubagentRuntime` |
| `jobs` / `invariants` / `tools` / `systemPrompt` | 均 YES |

工作流家族的包与它们的 `inject`：

| 包 | 版本 | cordis name | inject |
| --- | --- | --- | --- |
| `dsh-workflow` | 0.2.0-rc.2 | `workflow-invariant` | `invariants` |
| `dsh-tool-workflow` | 0.2.0-rc.2 | `tool-workflow` | `invariants, systemPrompt, tools, workflowEngine` |
| `dsh-workflow-ptc` | 0.2.0-rc.2 | — | `ptcRuntime, sandboxPolicy, subagents` |
| `dsh-client-ui-workflow-run` | 0.2.0-rc.2 | — | （UI 面用 `dsh.client.inject`，见其 package.json） |

**`dsh-tool-workflow` 的 inject 就是"消费工作流能力的插件"的 inject 基线**：`invariants, systemPrompt, tools, workflowEngine`。写 D5 插件时照这个起点，不要自己发挥。

## 4. 探针自身的准确性问题（已修，记录在此以免复发）

第一版探针是错的，两类错误都出现了，这正是"猜"的代价：

| 错误 | 表现 | 原因 | 修法 |
| --- | --- | --- | --- |
| 假阳性 | 把 `CODE_RUN_FAILED`、`DECLINED` 当成服务名 | 正则匹配 `super(x, 'NAME')`，而 `Error` 子类也用这个形状带错误码 | 只在 `extends *Service` 的类体内才认 `super(ctx, 'name')` |
| 假阴性 | 128→97 后 `subagents` 反而消失 | bundler 把基类改名成 `extends _classSuper`；`inject` 还有 `static inject = [...]` 形式 | 解析基类别名（`X = *Service`）+ 同时匹配两种 `inject` 形式 |

最终 125 个服务、FP/FN 双向清空，`--require` 门禁在 `workflowEngine`（exit 0）与 `workflows`（exit 1）上双向验证过。

## 5. 一个需要你裁定的新发现：R16/R17 可能已有原生先例

探针在 `inject` 列表里翻出了这个：

```
dsh-experimental-agent-team    inject=agents, invariants, sessionPersistence,
                                      sessionProjections, sessions, subagents
```

配套还有 `dsh-experimental-client-ui-agent-team`（UI 面），以及任务板工具里已经存在的 `teamRun` 语义：
「运行本任务会启动**一个 Team Lead 会话**，Host 为每个子任务派生一个 teammate」。

**这可能正是 R16/R17 想要的东西**：Lead + 成员的多会话编排、会话持久化、会话投影、UI 面——一整套都在 `@deepseek-ai/*` 里，且是官方包。

**我按纪律没有擅自改判定**（R16/R17 目前记为 ⚠️ + 需宿主侧包装）。建议下一步先探它，再决定 D5 是自研还是复用：

```powershell
python probe-services.py --explain agentTeams
python probe-services.py --explain agentPresets
# 并在宿主端确认任务板的 teamRun 是否可直接用：
#   任务板 UI 新建一张卡 -> 打开 teamRun -> 运行
```

若 `dsh-experimental-agent-team` 能满足"与工作区平行的独立模式 + 会话列表隔离"，**R16/R17 很可能从"自研"变成"配置 + 薄包装"**，D5 的工作量会大幅下降。这是目前最值得先花 10 分钟确认的一件事。

## 7. R16/R17：模式启用配方（原生几乎全覆盖）

探宿主后发现 R16/R17 要的东西**大部分原生已有**，所以这一步是**配置**，不是开发。

### 7a. 落地顺序（按已确认的方案）

```powershell
# ⛔ 第 1、2 步已作废：那 6 个插件 + Workflow Studio 与 0.2.0-rc.2 不兼容，已移除且禁止重装
#    （工具调度器 Symbol 错配 → Cannot read properties of undefined (reading 'prepare')
#      → 界面「本轮运行失败」）。详见 HOST-INSTALL-CHECKLIST.md 第 7 节。

# 1) 服务门禁：官方 workflow 能力是否已启用（官方包已随 app.asar 打包，不从 npm 装）
python docs\workflow-mode\probe-services.py --require workflowEngine --require tools
#    退出码 0 = 已在，什么都不用装；退出码 1 = 该能力未启用（不要用 npm 装同名包补）

# 2) 装本层（治理层 + R7 契约层）—— 唯一需要新装的东西
dsh plugin --profile web add link:<repo>\local-plugins\dsh-workflow-governance

# 3) 合成树里工作流引擎条目不得重复
dsh --profile web --dump-config
```

**第 3 步为什么必须看**：一个 context 只能有一个 `workflowEngine`，重复插入会抛错。本层 patch
**只插入自己**（它连官方引擎都不插），所以这一步是在确认宿主组合本身没有重复插引擎。

### 7b. 本层配置（默认全关）

在同目录建 `config.json`（**不存在 = 全部开关默认关**，开关清单以 `src/config.js` 为准，这是默认且最安全的状态）：

```json
{
  "switches": { "workflowMode": false, "deadlockDetector": true, "semanticMatcher": false, "capabilityGate": false, "contracts": true, "templateLibrary": true, "resultArtifacts": true },
  "deadlock": { "scanIntervalMs": 30000, "idleTimeoutMs": 60000, "escalateAfter": 3 },
  "contracts": { "maxAttemptsPerNode": 2 }
}
```

- `deadlockDetector` → 订阅 6 个 `workflow/*` 事件，静默超阈值即告警（**只观测，从不 cancel/dispose**）
- `contracts` → 注册 `contract_workflow` 工具（R7）

### 7c. R7 怎么用（契约门控的工作流）

让模型调用 `contract_workflow`，参数是一张带边契约的图：

> **名字为什么不是 `run_workflow`**：宿主已有一个叫 `run_workflow` 的工具，安全底线禁止与
> 原生能力撞名或遮蔽，所以本层的工具用命名空间化的 `contract_workflow`。

```json
{
  "workflow": {
    "nodes": [
      { "id": "collect", "prompt": "收集三个子系统的资料" },
      { "id": "synthesize", "prompt": "汇总成结论" }
    ],
    "edges": [
      { "from": "collect", "to": "synthesize",
        "when": { "type": "object", "required": ["sources"],
                  "properties": { "sources": { "type": "array", "minItems": 1 } },
                  "additionalProperties": false } }
    ]
  }
}
```

判据（每一条都有对应测试）：

| 场景 | 期望 |
| --- | --- |
| 产出满足边契约 | `status=COMPLETED`，下游拿到上游产出 |
| 上游产出违反边契约 | 上游**被重跑**最多 `maxAttemptsPerNode` 次；用尽则 `status=OUTPUT_VIOLATES_CONTRACT` 且 `upstream` 点名该节点；**下游从未被启动** |
| 边契约用了本层无法强制的关键字（`$ref`/`patternProperties`/`format`…） | `status=INVALID_WORKFLOW`，**一个 agent 都不会被创建**（fail-closed，绝不静默降级成"无约束"） |
| 边没有 `when` | 定义被拒（不允许无约束边） |
| `ctx.agents` 不可用 | `status=NODE_FAILED`，错误信息点名 `ctx.agents.create is unavailable` |
| `switches.contracts=false` | **不注册任何工具**，`contract_workflow` 不可见 |

**唯一未核验的细节**：`ctx.agents.create(...)` 的**选项袋形状**。它被参数化为 `options.buildCreateRequest`；形状不符时会抛出点名缺失能力的错误，不会静默跑错。

### 7d. R17 若要物理级硬隔离

独立 profile 让配置/会话/产物与默认 profile 物理分离：

```powershell
# 新 profile 里只放本层，不要把任何社区 workflow 插件装进去
dsh plugin --profile workflow add link:<此仓库>\local-plugins\dsh-workflow-governance
dsh --profile workflow web
```

> ⛔ **注意**：早先这里写的是 `dsh plugin --profile workflow add dsh-workflow`（Workflow Studio）。
> 该插件与 `0.2.0-rc.2` 不兼容、已被移除，**不要照旧命令装**。

判据：两个 profile 的会话存储目录不同；在 `workflow` profile 里建的会话不出现在默认 profile 的任何视图（含**单列表**）中。这比"独立 Workspace + 视图分组"强——后者切到单列表就能互相看到。

### 7e. 启用官方工作流能力（**不要从 npm 装**）

官方 workflow 包（`@deepseek-ai/dsh-workflow`、`dsh-tool-workflow`、`dsh-workflow-ptc`、
`dsh-client-ui-workflow-run`）**已随 `app.asar` 打包**。判据只有一条：

```powershell
python docs\workflow-mode\probe-services.py --require workflowEngine --require tools
```

- 退出码 **0** → 已在，什么都不用装，跳过本节。
- 退出码 1 → 该能力未启用。**不要用 `dsh plugin add @deepseek-ai/...` 从 npm 装同名包**：
  那会在 profile 里再落一份物理副本，正是 `prepare` 事故的成因。正确做法是在宿主端
  把已打包的包挂进组合（等同官方 base 的加载方式），并在改动前后各跑一次
  `--dump-config` 确认**没有重复的引擎条目**。

**一个 context 只能有一个引擎，插入第二个会抛错**——本层 patch 连引擎都不插，所以它不会
与任何组合冲突。

### 7f. 装本层 bundle（治理层）

```powershell
dsh plugin --profile web add link:<此仓库>\local-plugins\dsh-workflow-governance
```

判据：装完 `--dump-config` 多 **1** 条（`workflow-governance`）；**默认完全惰性**（配置不存在 = 全部开关默认关，插件只打一行 info 就返回）。

想开停滞检测：在同目录建 `config.json`（不存在即全关，这是默认）：

```json
{
  "switches": { "workflowMode": false, "deadlockDetector": true, "semanticMatcher": false, "capabilityGate": false, "contracts": true, "templateLibrary": true, "resultArtifacts": true },
  "deadlock": { "scanIntervalMs": 30000, "idleTimeoutMs": 60000, "escalateAfter": 3 }
}
```

### 7c. 建立 workflow 模式容器（用原生 Workspace）

1. 侧边栏「**添加工作区**」→ 选一个专门放工作流产物的目录
2. 「**视图选项 → 分组方式 → 按工作区**」（默认值）或「按工作区树」
3. 在该工作区里跑工作流；它的 Session 归自己

**R16/R17 验收判据（可复现）**：

| 需求 | 操作 | 判据 |
| --- | --- | --- |
| R16 命名与位置 | 看侧边栏 | 多出一个与工作区**同级**的工作区分组，可被折叠/展开 |
| R16 搜索 | 侧边栏搜索框输入关键词 | 立即出标题/工作区匹配；250ms 后并入 Host 内容搜索，最多 20 条 |
| R16 添加文件夹 | 「添加工作区」选目录 | 注册成功并打开新 Session；层级模式下自动归入最近已注册祖先 |
| R16 更改视图 | 视图选项切三种分组方式 | 按工作区 / 按工作区树 / 单列表 三种都能切换且记忆折叠状态 |
| R17 会话独立 | 在 workflow 工作区建会话 vs 主工作区 | 分组视图下互不出现于对方分组 |

**R17 的诚实限制（不要按"硬隔离"宣传）**：把「分组方式」切到**单列表**就能同时看到两个工作区的 Session。所以这是**视图级隔离**。若要求的是任何视图下都不互见，则**未达成**，需另机制。

### 7g. 唯一未落地的一件

在侧边栏注册一个名叫 workflow 的**平行入口**，需要一个 client-UI slot 插件。它需要 `slots` 客户端 API 的**具体注册函数**与客户端 **UI 框架**的组件写法；工作区里唯一的本地 client 先例（`dsh-readability-guard/lib/client.js`）只操作 DOM、**不碰 slot**，提供不了这个先例。

契约已从 README 提取到位（`sidebar.workspaces` 命名 slot；`sidebar.panellist` 是 list slot、同 id 的 `main` 是 keyed slot），**但我不写这段代码**——它是唯一无法在本会话运行或断言的部分。功能上已由 `sidebar.workspaces` + 原生 Workspace 覆盖，只差一个更显眼的命名入口。

## 8. fixture 说明

`probe-fixtures/bad-plugin/` 是**刻意保留的负样本**，不是残留物：它注册 `workflowEngine`、注入 `noSuchService`、声明 `@deepseek-ai/dsh-workflow: ^9.9.9`，用来证明兼容性探针会真的报阻塞（而不是永远输出 OK）。删掉它，就失去了探针的回归证据。
