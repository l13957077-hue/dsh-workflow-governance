# 宿主端安装与校验清单（可直接粘贴执行）

> # ⛔ 先读这一节：本清单的第 1、2 节**已被作废，禁止执行**
>
> 本清单原来要求安装 6 个社区插件 + Workflow Studio。**实测结论：它们与 DSH
> `0.2.0-rc.2` 不兼容，装上会把 DSH 弄坏**——`dag` 画布缺 codec 崩启动，其余引发工具
> 调度器 Symbol 错配，表现为每次调用工具时报
> `Cannot read properties of undefined (reading 'prepare')`，界面上就是「本轮运行失败」。
>
> **这 7 个插件已全部移除，DSH 已恢复。** 已移除清单：
>
> | # | 插件 | 状态 |
> |---|---|---|
> | 1 | `@gm-hz/dsh-dag-workflow` | ❌ 已移除（缺 codec 崩启动） |
> | 2 | `@dsh-external/workflow`（base） | ❌ 已移除 |
> | 3 | `@duke-dsh-plugins/dsh-agent-approval` | ❌ 已移除 |
> | 4 | `dsh-budget` | ❌ 已移除 |
> | 5 | `dsh-swarm-orchestrator` | ❌ 已移除 |
> | 6 | `dsh-node-flow` | ❌ 已移除 |
> | 7 | `dsh-workflow`（Workflow Studio） | ❌ 已移除 |
>
> **不要因为第 1、2 节的命令还在就重装它们。** 那两节保留在此**仅作为历史记录与失败证据**，
> 用来解释为什么 R3/R11/R12/R14/R15/R16/R17 最终走的是官方 0.2.0 能力 + 自研治理层，
> 而不是社区插件。**下面的第 3–5 节（本层 bundle、验收、回滚）仍然有效。**
>
> 走的是**路线 3**：放弃社区插件，用 DSH 0.2.0 自带的官方 workflow 能力
> （`@deepseek-ai/dsh-workflow-ptc` 等已随 app.asar 打包）+ 只自研缺的治理层。

适用：DSH 宿主进程所在的 shell（桌面端内置终端 / 独立 CLI 终端）。
**本清单不在会话内执行**——会话内没有 `dsh`、且 shell 网络受限（见 `LANDING-PLAN.md` 第 0 节实测）。

**原则**：预检只读 → 人工确认 owner → 逐个安装逐个验证 → 全程留快照。
**禁止**：一次性批量安装、通配 `allowBuilds`、跳过预检、忽略同名多源、**重装上面那 7 个插件**。

---

## 0. 前置条件（逐条确认后再继续）

| # | 条件 | 确认命令 | 必须的结果 |
|---|---|---|---|
| 0.1 | 宿主 shell 能用 `dsh` | `Get-Command dsh` | 返回可执行文件路径，非报错 |
| 0.2 | 明确 profile 名 | `dsh plugin --help` | 输出中出现 `--profile`；本清单按 `web` 走，不同则全程替换 |
| 0.3 | 确认 `add/remove` 子命令拼写 | `dsh plugin --help` | **若实际拼写与 `add`/`remove` 不同，按 `--help` 为准，切勿猜** |
| 0.4 | 备份 profile | 见下方 0.5 | 有可回退的快照 |
| 0.5 | 抓取安装前快照 | `dsh --profile web --dump-config > dump-config-before.txt` | 文件非空；记下 sha256 |

```powershell
# 0.4 / 0.5 合并执行：先备份 profile 目录，再抓快照
$prof = "$env:USERPROFILE\.dsh"                       # 若 0.2 显示别的根目录，改这里
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $prof -Destination "$prof.bak-$stamp" -Recurse -Force
Write-Host "backup -> $prof.bak-$stamp"
dsh --profile web --dump-config | Tee-Object -FilePath "dump-config-before.txt"
(Get-FileHash dump-config-before.txt -Algorithm SHA256).Hash
```

**通过判据**：备份目录存在且非空；`dump-config-before.txt` 字节数 >0；sha256 已记录。

---

## 1. 预检（只读，不改任何东西）

> ⛔ **本节作废，仅供历史参考。** 预检解析出的 6 个坐标正是被移除的那 6 个不兼容插件。
> 下面第 2 节的安装命令**禁止执行**——照做会把 DSH 再次弄坏。
> 保留原文是因为它记录了坐标核验方法与 E404 发现，将来找 0.2.0 兼容版本时还有用。

```powershell
cd docs\workflow-mode
.\preflight.ps1 -Profile web
```

脚本行为（已在受限环境实测验证）：**只读**，唯一写入是 `preflight-out\` 下的快照与 CSV；从不安装、从不改 `pnpm-workspace.yaml`、从不加通配放行。

- 退出码 `0`（`PREFLIGHT: GO`）→ 继续第 2 节
- 退出码 `1`（`PREFLIGHT: NOT GO`）→ **停下**，按下面两处解决后重跑

**实测输出（本会话，离线环境）**——这就是"正确失败"的样子，对照此判断你的环境是否真的就绪：

```
== 1/5 environment ==
  dsh     : NOT FOUND on PATH          <- 你这行必须是路径
  npm     : 10.9.8
  git     : git version 2.56.0.windows.1
== 4/5 package source audit (read-only) ==
Gap  Kind   Spec                                  Owner Pin Verdict
base github omdsh-dev/dsh_workflow                          BLOCKED   <- 你这里必须是 GO + Owner + 40 位 sha
...
PREFLIGHT: NOT GO - resolve the rows above before installing anything
EXIT=1
```

### 1a. 解决 `NEEDS-DECISION`：同名多源必须人工拍板

```powershell
# D6 重试插件：确认到底哪个 owner 是你要的
npm view dsh-swarm-orchestrator repository.url
npm view dsh-swarm-orchestrator version
```
把解析出的 owner 回填后重跑：
```powershell
.\preflight.ps1 -Profile web -SwarmOwner '<解析出的 owner>'
```

```powershell
# R10 审批插件：brief 给的 @duke-dsh-plugins 未核验到，先确认候选源可达
git ls-remote https://github.com/MoonlitDropOfBlood/dsh-agent-approval.git HEAD
git ls-remote https://github.com/LAwLi3tCoding/dsh-approval-review.git HEAD
```
选定其中一个后：
```powershell
.\preflight.ps1 -Profile web -SwarmOwner '<owner>' -ApprovalOwner 'MoonlitDropOfBlood/dsh-agent-approval'
```

**通过判据**：6 行全部 `GO`，每行 `Owner` 非空、`Pin` 非空（npm 为版本号、GitHub 为 40 位 sha），退出码 0。

### 1b. 记录三处坐标纠正（勿照抄 brief）

| 位置 | brief 写的 | 实际用 |
|---|---|---|
| 基准插件 | `github:dsh-external/dsh_workflow#main` | `github:omdsh-dev/dsh_workflow#<sha>` |
| R10 审批 | `@duke-dsh-plugins/dsh-agent-approval` | 1a 中确认的 owner |
| D6 重试 | `dsh-swarm-orchestrator` | 1a 中确认的 owner 对应源 |

---

## 2. 安装（逐个装、逐个验，**不要合并**）

> ⛔ **本节作废，禁止执行。** 下面 2.1–2.7 要装的 6 个插件 + Workflow Studio 全部与
> `0.2.0-rc.2` 不兼容，实测会把 DSH 弄坏（工具调度器 Symbol 错配 →
> `Cannot read properties of undefined (reading 'prepare')` → 「本轮运行失败」）。
> **这 7 个插件已全部移除且不得重装。**
>
> 仍然有效、需要照做的只有：**§3 的本层 bundle 安装与本层验收**（见文末「路线 3 的替代安装步骤」）。

把 `<...>` 换成第 1 节预检输出里的真实值。全部按 `github:owner/repo#<40位sha>` 或 npm 精确版本固定。

### 2.1 基准插件（R1–R11 前提）

> 注意：`@dsh-external/workflow` **没有发布到 npm**（`npm view` E404）。不要尝试用 npm 装，必须用 GitHub 固定 commit。

```powershell
dsh plugin --profile web add "github:omdsh-dev/dsh_workflow#44b83c182aa02d1be8a0803e8446cb495f93cd8f"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `dsh --profile web --dump-config` 输出比快照多 **1** 条；若提示 `allowBuilds` → 转第 4 节 |
| 通过判据 | 新增条目名含 `workflow`；无绝对路径泄露；无其它非预期新增 |
| 失败回滚 | `dsh plugin --profile web remove <实际包名>` |

### 2.2 R7 边+数据契约

```powershell
dsh plugin --profile web add "@gm-hz/dsh-dag-workflow@<version>"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `--dump-config` 再增 **1** 条 |
| 通过判据 | 条目名含 `dag-workflow` |
| 失败回滚 | `dsh plugin --profile web remove @gm-hz/dsh-dag-workflow` |

### 2.3 R3 可视化画布

```powershell
dsh plugin --profile web add "github:CodermanYHZ/dsh-node-flow#<sha>"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `--dump-config` 再增 **1** 条；若提示 `allowBuilds` → 转第 4 节，**加完精确 key 后重试本条** |
| 通过判据 | 条目名含 `node-flow` |
| 失败回滚 | `dsh plugin --profile web remove <实际包名>` |

### 2.4 R10 动态授权（用 1a 选定值）

```powershell
dsh plugin --profile web add "github:<ApprovalOwner>#<sha>"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `--dump-config` 再增 **1** 条 |
| 通过判据 | 条目名含 `approval` |
| 失败回滚 | `dsh plugin --profile web remove <实际包名>` |

### 2.5 D7 预算熔断

```powershell
dsh plugin --profile web add "dsh-budget@<version>"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `--dump-config` 再增 **1** 条 |
| 通过判据 | 条目名含 `budget` |
| 失败回滚 | `dsh plugin --profile web remove dsh-budget` |

### 2.6 D6 重试/失败处理（用 1a 选定 owner）

```powershell
dsh plugin --profile web add "dsh-swarm-orchestrator@<version>"
```
| 项 | 内容 |
|---|---|
| 即时验证 | `--dump-config` 再增 **1** 条 |
| 通过判据 | 条目名含 `swarm` |
| 失败回滚 | `dsh plugin --profile web remove dsh-swarm-orchestrator` |

### 2.7 合成树总校验

```powershell
dsh --profile web --dump-config > dump-config-after.txt
$before = (Get-Content dump-config-before.txt)
$after  = (Get-Content dump-config-after.txt)
Compare-Object $before $after | Format-Table -AutoSize
```
**通过判据**：diff **恰好 6 条新增、0 条删除、0 条修改**。出现删除或修改 → **立即回滚第 5 节**。

---

## 3. 重启后的功能验证

重启 DSH Web，然后逐项核对：

| # | 验证 | 操作 | 通过判据（量化） |
|---|---|---|---|
| 3.1 | 基准流程 | `/workflow list` | 退出码 0 且列出 ≥1 条 |
| 3.2 | 端到端 | `/workflow parallel-investigation {"question":"..."}` | 阶段数 ≥2；每阶段有非空上游依赖字段；结果文件与流程图 JSON 均 >0 字节 |
| 3.3 | Canvas Studio | 打开画布 | 画布节点数 ≥1，且等于实际阶段数 |
| 3.4 | 自动审批 | `/permission` | 出现自动审批条目；审批页可看到裁决理由 |
| 3.5 | 预算面板 | 打开预算面板 | 显示 token 与费用数值，非 `0`/空白 |
| 3.6 | Swarm 看板 | 启动看板 | 可启动；并发数可配置并生效 |
| 3.7 | **R7 契约校验**（关键） | 让某节点输出**故意违反** `expects.schema` | **必须被拒绝**，且报错信息含违规字段名；不得静默通过 |

3.7 不通过 → R7 未真正被覆盖，须回到 `LANDING-PLAN.md` 第 4 节处理，**不要继续阶段2**。

---

## 4. `allowBuilds` 提示的处理（唯一允许改 profile 文件的情形）

仅在 2.1（base）或 2.3（node-flow）安装 GitHub 源时被提示才做——**这两个都走 GitHub 源，都可能触发**：

1. 第 1 节预检已打印 profile 下所有 `pnpm-workspace.yaml` 的路径与该文件现有 build-approval key；脚本找不到时会明确提示。
2. 打开该文件，**只添加提示里点名的那一个 key**（精确 owner/repo 形态）。
3. 重试 2.3 那一条命令。

**绝对禁止**：
- 加通配（如 `"*"`、`"@gm-hz/*"`）
- 添加提示里未点名的 key
- 因为提示烦就整体关闭 build 审批

---

## 5. 回滚

按粒度从细到粗，任选其一即可：

```powershell
# 5.1 单包回滚（推荐，最小影响）
dsh plugin --profile web remove <包名>

# 5.2 打包回滚：用第 0 节 diff 找出本次新增的 6 条，逐条 remove
Compare-Object (Get-Content dump-config-before.txt) (Get-Content dump-config-after.txt) |
  Where-Object SideIndicator -eq '=>' | ForEach-Object { $_.InputObject }

# 5.3 全量回滚：恢复第 0.4 步的 profile 备份
Remove-Item -LiteralPath "$env:USERPROFILE\.dsh" -Recurse -Force
Rename-Item -LiteralPath "$env:USERPROFILE\.dsh.bak-<stamp>" -NewName '.dsh'
```
**回滚验收判据**：`dsh --profile web --dump-config` 的 sha256 与第 0.5 步记录的**完全一致**（5.3），或 diff 中不再有本次新增条目（5.1/5.2）。

5.3 会删除 `\$env:USERPROFILE\.dsh`——执行前**必须**先 `Resolve-Path` 确认目标确实是该目录且备份存在。

---

## 6. 路线 3 的替代安装步骤（**照这一节做**）

社区插件路线已作废。只剩两件事要做：**启用官方 workflow 能力**（若未启用）+ **装本层 bundle**。

### 6.0 ⚠ 本机**没有** `dsh` 命令 —— 先读这一节

**实测结论**（逐条核过，不是推测）：

| 位置 | 结果 |
| --- | --- |
| `%APPDATA%\dsh-desktop\bin` | 目录存在，**没有 dsh 启动器** |
| `%APPDATA%\dsh-desktop\harness\.desktop-bin` | 只有 `node.cmd` / `pnpm.cmd` / `git.cmd` / `gh.cmd` |
| 用户级 PATH + 机器级 PATH | **没有任何 dsh 条目** |

所以本文档里所有写成 `dsh …` 的命令，**在这台机器上都会报「'dsh' 不是内部或外部命令」**。
必须用完整路径调用（下面三个路径都已核对）：

```powershell
# 必须用 PowerShell，不要用 cmd（cmd 不认 $env: 语法）
# 不要「以管理员身份运行」，且必须与主 app 同一个用户（%APPDATA% 要一样）
cd $env:USERPROFILE      # 中性工作目录，不要在某个聊天/临时目录里起

$exe   = "$env:LOCALAPPDATA\Programs\DSH Desktop\DSH Desktop.exe"
$entry = "$env:LOCALAPPDATA\Programs\DSH Desktop\resources\harness-node-entry.mjs"
$bin   = "$env:LOCALAPPDATA\Programs\DSH Desktop\resources\app.asar\node_modules\@deepseek-ai\dsh\lib\bin.js"

& $exe $entry $bin --profile web web
#                            ^^^^^^^^^^^ ^^^
#                            profile 名   子命令（web / headless …）
# 于是本文档里的 `dsh plugin --profile web add link:…` 等价于：
& $exe $entry $bin --profile web plugin --profile web add link:<repo>\local-plugins\dsh-workflow-governance
```

**启动三条铁律**——违反任何一条，故障都表现为「**静默挂起、不绑端口、不报错**」：

1. **前台运行**。不要 `| Out-File`、不要 `2>&1 >…`、不要隐藏窗口：否则宿主的任何**交互式提问**都会变成看不见的死等。
2. **非管理员**，且与主 app 同用户。
3. **中性 cwd**。已知一次挂起的现场是 `cwd=<some non-project dir>`，`_web-out.log` 停在 `invoking DSH runCli()` 之后**再无任何输出**，且**没有写任何 startup 日志**（那条审计没走到）。

**卡住时怎么取证**：按 `Ctrl+C`，把最后吐出的内容发出来（常有半截栈或阶段名）。若打印出的是一句**问话**并等你输入，那句话就是根因——而重定向下你永远看不到它。

### 6.1 装本层 bundle（唯一需要新装的东西）

```powershell
# 按 §6.0 的写法展开；`dsh …` 只是简写
& $exe $entry $bin --profile web plugin --profile web add link:<repo>\local-plugins\dsh-workflow-governance
```

**安装前必须确认这条**（它保证本层不会重演 `prepare` 事故）：

```powershell
# 本层不声明任何依赖；lib/index.js 不 import/require 任何 @deepseek-ai 包
python -c "import json;print(json.load(open(r'local-plugins/dsh-workflow-governance/package.json')).get('dependencies'))"
node -e "import('./local-plugins/dsh-workflow-governance/lib/index.js').then(()=>console.log('IMPORT OK')).catch(e=>console.log('FAIL '+e.message))"
```

期望：依赖打印 `None`；第二行打印 `IMPORT OK`。
**`IMPORT OK` 是关键**——它在没有宿主包的环境里加载成功，说明包装器没有理由把
`@deepseek-ai/dsh-tools` 物化到 profile 里（那正是之前弄坏 DSH 的原因）。
本层还带 6 项自动回归测试钉住这条性质：`node test/bundle.test.mjs`。

安装后判据：
- `dsh --profile web --dump-config` 只多 **1** 条（`workflow-governance`）；
- **默认全关即完全惰性**（无 `config.json` 时全部开关默认关，清单以 `src/config.js` 为准）。

### 6.2 启用官方 workflow 能力（宿主端，只做一次）

官方 workflow 包**已随 app.asar 打包**（`@deepseek-ai/dsh-workflow`、
`dsh-tool-workflow`、`dsh-workflow-ptc`、`dsh-client-ui-workflow-run`），**不需要从 npm 装**：

```powershell
python docs\workflow-mode\probe-services.py --require workflowEngine --require tools
```

- 退出码 **0** → 服务已在，什么都不用装。
- 退出码 1 → 该能力未启用，再决定是否在宿主端显式挂载（**不要**从 npm 装同名包，
  那会引入第二份物理副本 = 重演事故）。

### 6.3 阶段2 验收

```powershell
cd docs\workflow-mode
node verify\checks.test.mjs                     # 36 项判定单测，期望 exit 0
copy verify\stage2-trace.template.json verify\stage2-trace.json
# 按 verify/README.md 的字段表填真实观察值，再：
node verify\run.mjs --trace verify\stage2-trace.json
```

期望 **CORE 7/7 PASS**。先看绿色样板（假数据，会警告且 exit 1）：
```powershell
node verify\run.mjs --trace verify\stage2-trace.example.json
```

### 6.4 将来若要评估某个第三方插件

**先做静态兼容性检查再谈安装**（本层自带这个工具，且它不会改任何东西）：

```powershell
npm pack <spec>
tar -xzf <file>.tgz
python probe-plugin-compat.py --plugin .\package --name "<spec>"
```

它会报出：依赖版本漂移、`inject` 的服务在本 build 是否存在、**它注册的服务名是否与本
build 重名**。`STATIC-BLOCKER` 一律不装。**注意它只能证明"有阻塞"，不能证明"兼容"**——
最终结论仍需一次可回滚的真实加载。

---

### 6.5 硬隔离 profile（R17）：现状、为什么用"副本"、以及哪些验证是可选的

**R17 的隔离已经实测成立过**，证据是一次成功启动：

| 判据 | 观察 |
| --- | --- |
| profile 目录分离 | `profiles\web` 与 `profiles\workflow` 是两个独立目录 |
| 会话不互通 | workflow 的存储里查不到 web profile 的任何会话 id |
| 主 profile 未受影响 | web 一直在 43129 正常监听，全程未动 |
| 插件在新 profile 里干净激活 | 副本自己的 `state\startup.json`：`defineTool true`、`registeredTools` 两个都在、`notes []` |

**为什么隔离 profile 用"副本"而不是软链**：软链指向同一个包目录 → 两个 profile 会**共用**
`config.json`、`library/`、`results/`，那就不是真隔离。复制一份，副本里的配置与产物才属于它自己。
代价：**本层源码更新后必须重刷副本**（清 `state`/`library`/`results`，保留 `config.json`），
而安装指向的路径不变，**不需要重新 `plugin add`**。

**当前已知的一次拉不起来（如实记录，未解决）**：刷新副本后重复用
`& $exe $entry $bin --profile workflow web` 拉起，两次都停在 `invoking DSH runCli()` 之后无输出、
不绑端口、不写 startup 日志。已排除的：插件激活（副本的自检报告证明新代码激活成功且零告警）、
端口占用（43127 空闲）、junction 完整性（目标存在）。**未排除的**：手工用 Electron 主程序当运行时
（主 app 已在跑）、以及被重定向隐藏的交互式提问。**处理方式：前台重试一次（§6.0），不反复拉起**——
反复拉起会产生孤儿进程，代价大于收益。

**可选验证（测试已覆盖，现场复验是加分项，不是证据缺口）**：

| 验证 | 现场步骤 | 若不做的后果 |
| --- | --- | --- |
| **R9/R10 门禁** 6 步 | `gate_status` → 未授权运行被拒 → `gate_request` → `gate_decide` 批准 → 运行 `COMPLETED` → 再运行被 `CONSUMED` 拒 | **无**：这 8 条路径已被 `test/plugin.test.mjs` 逐条断言（含"被拒时不 spawn 任何节点"） |
| **R11 落盘** | `Get-ChildItem <副本>\results \| Sort-Object Name -Descending \| Select-Object -First 1 \| Get-Content -Raw` | **无**：`test/artifacts.test.mjs` 12 项覆盖裁决+拓扑+图、原子写、裁剪、越界读、写失败降级 |
| **R4 声明/推断** | 对含推断边的图取 `action=diagram`，该边应为**虚线**且标 `inferred: …` | **无**：`test/diagram.test.mjs` 4 项覆盖 provenance 计数、虚线渲染、说明文字 |

---

### 6.6 装「Workflow 工作模式」入口（R16，可选但推荐）

R16 要的"与普通对话区分开的入口"用**官方 Agent 预设**实现，**不需要 client-UI 插件**：
新建会话的**预设选择器**就是入口（本机已有 UltraMath×5 与 `project-plugin-selector` 作先例）。

```powershell
# 预设源在工作区内；目标目录在 %APPDATA%（宿主路径，本层不主动写）
Copy-Item -Recurse -Force `
  "<workspace>\local-plugins\dsh-workflow-governance\presets\workflow" `
  "$env:APPDATA\dsh-desktop\harness\.agent-presets\workflow"
Get-Content "$env:APPDATA\dsh-desktop\harness\.agent-presets\workflow\preset.yml"
```

然后重启 DSH，**新建会话时在预设选择器里选「Workflow 工作模式」**——该会话即与普通对话分开的 workflow 入口。
它的 persona 会按"查库复用 → 声明带契约的图 → 违反契约不绕过 → 落盘 → 门禁 → `observed`"推进。

**回滚**：删掉 `%APPDATA%\dsh-desktop\harness\.agent-presets\workflow\` 即可，不影响任何其他会话。

**加载失败的排查（已踩过的两个坑）**：

1. `tool-todo` 在本机版本里**必填** `config.allowParallelInProgress`；缺了它整个预设加载失败
   （报 `agent preset workflow: tool-todo: invalid config: $.allowParallelInProgress missing required value`）。
2. **迁移备份也会被校验**：`<DSH_HOME>\.agent-presets\.persona-prefix-backups\workflow\agent.cordis.yml`
   如果还是旧版本，活跃那份修好了，卡片**仍然**显示「加载失败」。两份都得对。
3. 应用会在启动时**重写**预设文件（`persona.text`→`prefix`，并压掉注释）：所以**工作区里那份是源**，
   预设库里那份是派生物 —— 只改源再复制，不要反过来改。
4. 真凭据在 `%APPDATA%\dsh-desktop\logs\harness.log`：应用占着这个文件，必须用**共享读**打开
   （`[System.IO.File]::ReadAllLines` 会报"正由另一进程使用"）；搜 `agent-preset-registry`。


**为什么本层不自动同步预设**：UltraMath 那类插件会在启动时写 `%APPDATA%`，但本层的安全基线是
"不主动写宿主路径"。所以它是**一份可交付资产 + 一条你执行的复制命令**，而不是一次隐式写入。

---

### 6.7 看官方引擎跑的运行（R4 的推断半边）

重启后任一会话里：先用**官方 `workflow` 工具**跑一次小脚本（它才会发 `workflow/*` 事件），然后

```
contract_workflow_library {action:"observed"}                    → 列出被观测到的运行
contract_workflow_library {action:"observed", name:"<运行 id>"}   → 该运行的拓扑投影
```

期望：跑出 Mermaid，且**每条边都是虚线**并标注 `inferred: phase-order`；`shape` 行会写
`N edge(s) (M inferred, not declared)`。**这些边是按阶段顺序推断的，不是声明的事实** ——
要事实就自己声明一张带契约的图。

前提：`switches.deadlockDetector` 要开着（否则返回 `OBSERVATION_OFF` 并说明原因）。

---
## 7. 历史记录：为什么社区插件路线被放弃

| 现象 | 根因 | 证据 |
| --- | --- | --- |
| 每次调用工具都「本轮运行失败」，报 `Cannot read properties of undefined (reading 'prepare')` | 第三方插件在 web profile 带进一份**物理 `dsh-tools`**，它的工具调度器 Symbol 与 app.asar 主程序里的**不是同一个对象**，于是 `ctx.tools[...].prepare` 读到 undefined | 移除 7 个插件后冷启动 `Harness is ready`，`prepare` 报错 0 条；web 界面新建会话调用文件工具成功返回 |
| `dag` 画布崩启动 | `@gm-hz/dsh-dag-workflow` 缺 codec | 启动即崩 |
| 其余插件 | 按旧版 harness `0.0.1-rc.2` 编写，与 `0.2.0-rc.2` 符号错配 | 工具调度器符号不一致 |

**持久修复（由宿主端完成，本层未参与也未改动）**：在 web profile 放 `.pnpmfile.cjs`，
令 `@deepseek-ai/dsh-tools` 永不落地到 profile，运行时统一用 app.asar 副本；删除冲突的
override（保留 `dsh-llm`）。**本层与该修复不冲突**：本层不声明依赖、不 import 官方包，
所以 `.pnpmfile.cjs` 对它无事可做。
