# Workflow 预设 · 完整验收自测提示词

把下面 `=====` 之间整段复制，粘贴进「Workflow 工作模式」预设会话，让它逐项执行并
**如实报 PASS/FAIL**，每项附真实工具返回的关键字段，不许编造。构造图时用最小可用图即可。

=====

对「Workflow 工作模式」做一次完整自测。严格按顺序执行，每项标 PASS 或 FAIL 并附真实返回证据。

【一 · 工具与加载】
1. 确认本会话有 contract_workflow 与 contract_workflow_library 两个工具。
2. contract_workflow_library action="report"：应列出 9 张图（demo、demo-block、demo-decision、demo-multi、sample-inline、sample-nonce、sample-summary、bash-smoke-test、整理周报），每张带 n/e、rev、runs、ok、rate。

【二 · 模板库读取】
3. find query={task:"整理周报"}：应 decision=reuse、score=1.0。
4. find query={task:"把本周活动整理成一份周报，带证据核对"}：如实记录 decision 与 score（预期低分或 create，证明匹配是关键词级）。
5. get name="demo-multi"：应带出 7 个节点与 7 条边契约（不是只有一行名字）。
6. export name="demo-multi"：应带出 JSON（不是只有 code EXPORTED）。
7. diagram name="demo-multi"：应输出完整 Mermaid（decision 默认分支、join 可见）。

【三 · 图合法性（save 应真拒绝）】
8. save 一张边没有 when 的图：应 INVALID_WORKFLOW 拒存。
9. save 一张 join 声明 waitPolicy="any" 的图：应被拒。
10. save 一张有环的图：应被拒。
11. save 一张合法两节点图（带 when）：应 CREATED，随后 remove 清理。

【四 · 节点预设 / 工具分配（关键需求）】
12. 跑一张两节点图：节点 A 设 toolFilter deny read、节点 B 不设，让两者分别报告能否 read 同一个文件；预期 A=false、B=true。
13. 节点 A 的 persona 里加一条"必须额外输出字段 X=固定值"（prompt 里不写这个字段），验证 X 出现在 A 的输出。

【五 · 契约与容错】
14. 跑一张出边契约要求一个节点不会自然产出的字段的图：应观察到退回重试（该节点 attempts≥2）后成功，或重试用尽后 OUTPUT_VIOLATES_CONTRACT + dlq 1（带具体字段）。

【六 · 按名运行 + 记账 + 历史】
15. contract_workflow name="demo"：应 COMPLETED。
16. report 看 demo：runs 应 +1。
17. 读库文件看 demo 的 history 最新一条：应含 at（时间）与 sessionTitle（对话标题，非 null）。

【七 · 门禁与安全】
18. gate_status：记录 enabled 与 capabilities（当前 config 未开 capabilityGate，预期 enabled:false）。
19. 确认本次自测没有写 profiles / cordis.patch.yml / app.asar / 其他预设（只读）。

最后输出一张汇总表：每项 PASS/FAIL，FAIL 项附真实返回里能定位原因的那段原文。

=====

## 说明

- 第 12、13、14 步需要临时构造图，用 `contract_workflow` 的 inline `workflow` 或
  `contract_workflow_library save` 均可；测完把临时图 remove，保持库干净。
- 第 15 步会真实消耗一次 `demo` 的运行并计入它的 history（这正是要验证的记账）。
- 全套下来预期结论：**一~七 全 PASS**；若有 FAIL，把 FAIL 项的返回原文发我。
