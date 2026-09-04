# Agent Notes · 2026-09-05 · 核心运行层实现

## 改了什么

- 重写 `src/types.ts`，增加 decision/execution/verification 三段状态、固定 action identity（session/branch/agent/turn/step）、受控 `ToolResult` 与 verification evidence、事件 `sequence/source`、runtime retry/report 字段。
- 重写 `src/judge.ts`，保留独立 `DecisionJudge` 与 `DecisionRecorder` 接口；deterministic judge/recorder 仅作为无模型本地 fallback，并记录 confidence、drift 和自主决策信息。
- 重写 `src/stream.ts`，建立 `judge -> recorder -> gate -> executor -> evidence` 链路。红卡阻断，蓝卡记录后放行，灰卡直接执行；默认 `LocalAgentExecutor` 可在本地读写文件和执行命令，executor 可替换。
- 为 session、agent、turn、card 和审批 gate 接入 `AbortSignal`；审批超时 fail-closed；重复裁决相同输入幂等、冲突输入明确报错。
- 实现显式 `forward-only` 与 `rewind-and-fork`。前者追加未来约束且不改历史，后者仅接受初始或已完成 turn 边界，保留父分支并提供 `redo` 入口。`WorkspaceSnapshotAdapter` 只提供物理快照接缝，默认 adapter 只生成逻辑快照，不伪装回滚文件；fork 事件标明外部副作用不可撤销。
- runtime failure 与 recording drift 分离；executor 失败最多重试 3 次后进入 failed/blocked-help 记录，drift 只标记不阻断；只有 executor 返回并绑定 card/execution 的 passed evidence 才能变 green。
- 扩展 `src/stream.test.ts` 到 16 项，覆盖红卡真实执行、forward 改道、取消/超时、append-only sequence、双模式、turn boundary fork/redo、多 agent 并发隔离、幂等裁决、runtime retry、evidence policy、side effect metadata 和 report。

## 为什么

三份 requirements 分别强调运行中决策治理、异源记录/对账、以及 rewind-and-fork 的保留原分支语义。核心层需要同时表达两种模式，不能用隐式回滚或单一卡片状态掩盖执行失败和验证失败。真实 executor 与受控证据分开，是为了避免“工具没失败”被错误解释成“结果已验证”。

## 影响

- `server.ts`、UI 和需求文档未修改；现有 demo API 仍可调用 `execute/decide/verify/report`。
- 默认 executor 的写文件/命令动作可能产生真实本地副作用；测试产生的临时 `db.sql`、`db.sqlite` 已删除。生产接入应传入 workspace root、sandbox executor 和真实 snapshot adapter。
- 当前 `rewind-and-fork` 的父子关系和事件是完整的，但文件物理恢复仍明确依赖外部 adapter，不由本核心假装完成。

## 验证

- `npm install`：成功；npm 报告已有依赖审计漏洞，未执行破坏性 `npm audit fix`。
- `npm run typecheck`：通过。
- `npm test`：通过，16/16。
- `npm run build`：通过。

## 后续修正

- 补充 card-created 的结构化 `humanInstruction`/`agentAction` 记录，并让带 card 的事件从 card identity 派生 branch，避免并发 fork 时事件错误归属当前活动分支。
- 修正后再次完成 `npm run typecheck`、`npm test`（16/16）和 `npm run build`；测试生成的本地临时文件随后清理。
