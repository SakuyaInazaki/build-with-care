# Agent Notes · 2026-09-05 · dsh adapter 契约与需求索引

## 本次变更

- 新增 `src/adapters/dsh.ts`，定义不依赖 dsh 包类型的 `DshAdapter` 接口：`tools/pre-execute`、`agent.inject`、`agent.cancel`、session event、turn boundary 和 fork。
- 新增 `mapDshEvent()`，把 dsh 事件映射为本地 `TimelineEvent`；保留 `provider`、`version`、`externalType`、原始 payload 和未知事件。
- 新增 `MockDshAdapter`，只模拟协议，不执行工具、不声称连接 dsh；支持 pending gate、allow/deny、future-only injection、取消和 completed-turn fork。
- 新增 `src/adapters/dsh.test.ts`，断言 deny reason、inject only future、cancel pending、event ordering、turn boundary/fork、未知事件和未安装 runtime 诊断。
- 扩展本地 `TimelineEvent` 的 provenance 字段和 `session-end` / `adapter-event` 类型。
- README 增加 dsh / workspace / side effect / recorder 能力矩阵。

## 动机

三份 requirements 的共同交集是：人治理 Agent 的运行时动作和过程证据，但 dsh 只应作为可替换底座。已有 dsh 调研还明确了四条不能模糊的边界：不能改写工具入参；forward-only 注入只影响后续；session fork 不提供工作区文件快照；外部副作用不可回滚。adapter 契约把这些行为写成可测试的 seam，避免把研究结论误写成真实接入完成。

## 需求索引

| 来源 | 关键决策 | 本仓库对应 | 当前状态 |
|---|---|---|---|
| `docs/requirements-alignment.md` | 决策流、forward-only、红/蓝/灰分层、人的纠偏记录 | `src/stream.ts`、README、现有 stream tests | 已实现为本地 core |
| `docs/requirements-alignment-Y.md` | dsh 插件路线；pre-execute、inject、cancel；alpha 锁版本 | `src/adapters/dsh.ts`、README 能力矩阵 | 契约/smoke 已实现，真实 adapter 未实现 |
| `docs/requirements-alignment-S.md` | dsh 事件记录、多 agent、rewind/fork、workspace 快照依赖 | `mapDshEvent()`、`WorkspaceSnapshotAdapter`、README | 事件契约和逻辑 fork 有；物理快照未实现 |
| `docs/research-dsh-Y.md` | deny + 注入而不是改参；自建事件桥；alpha 风险 | dsh adapter provenance、unknown handling、诊断 | 已纳入协议；真实桥未实现 |
| `docs/research-2-raw/05-dsh-feasibility-S.md` | append-only session event、turn/step、fork 仅会话层 | event mapping、completed-turn gate | 已覆盖核心边界 |

## 之前 agent 的变更

| 记录 | 变更与动机 | 影响 | 验证 |
|---|---|---|---|
| `2026-09-04-research-round-2.md` | 完成赛题拆解、技术/竞品/中文社区调研，识别运行中决策层空白 | 形成 dsh 路线和产品边界输入 | 文档来源记录；未实现代码 |
| `2026-09-05-core-runtime.md` | 建立 judge/recorder/gate/executor/evidence core，支持两种纠偏模式 | 本地 demo 有真实执行与逻辑 fork，但不假装物理回滚 | 记录中为 typecheck、16 tests、build |
| `2026-09-05-server-persistence-api.md` | 增加 JSONL 恢复、HTTP session 隔离、安全边界 | 本地状态可重启恢复；dsh、异源模型、物理快照仍未接入 | 记录中为 npm install、typecheck、21 tests、build |
| `2026-09-05-ui-demo-report.md` | 建立中文工作台、演示流、时间线和报告 | 可通过本地 demo 展示人的裁决和证据 | 记录中为 typecheck、23 tests、build |

## 未实现与风险

- 没有把 `@deepseek-ai/dsh` 加入依赖。npm registry 当前可见 `0.1.2-rc.1`，目标 `0.1.3-alpha.1` 查询为 404；因此 `package.json` 的目标版本元数据仍是声明，不是安装证明。
- `requireRealDshRuntime()` 只做存在性/版本诊断，不会返回假的 adapter。真实 adapter 仍需基于实际锁定 commit/package API 实现，并在真实 dsh 环境跑 POC。
- `MockDshAdapter` 没有工具执行、模型请求或浏览器 UI；它只验证 adapter 协议和顺序。
- `mapDshEvent()` 对未知事件采用保留式降级，不能替代未来 dsh 版本的语义适配审核。
- `WorkspaceSnapshotAdapter` 仍是外部注入 seam；当前逻辑 fork 不恢复文件，也不撤销外部副作用。
- 三份 requirements 原文未修改；本条记录和 README 是索引/实现状态，不是需求重写。

## 本次验证

- `npm view @deepseek-ai/dsh@0.1.3-alpha.1 version --json`：404，未添加虚假依赖。
- `npm install`：成功；npm 报告已有 5 个审计漏洞，未执行破坏性 `npm audit fix`。
- `npm run typecheck`：通过。
- `npm test`：通过，5 个测试文件、28/28；新增 dsh adapter smoke 为 5 项。
- `npm run build`：通过。
- `git diff --check`：通过；本次未提交 commit。
