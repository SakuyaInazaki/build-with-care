# 看着办 · Agent 工作台


## 当前前端

新的产品入口为 `frontend/`，从空白文件重建，使用 Apple Design 与 Refactoring UI；不复用旧前端页面、组件或样式。语义以 [`docs/requirements-v1-frozen.md`](./docs/requirements-v1-frozen.md) 为准。

```sh
pnpm --dir decision-desk install --frozen-lockfile
npm --prefix frontend ci
npm run dev
```

打开 http://127.0.0.1:4317。生产预览使用 `npm run build` 和 `npm start`。新前端运行说明、验证结果及已知后端边界见 [`frontend/README.md`](./frontend/README.md)，本次变更记录在 [`.agent/notes/`](./.agent/notes/)。项目名称经用户确认采用“看着办”；历史名称保留在旧实现说明中。

## 历史实现说明

下文保留冻结前两套实现的历史说明，其中分支、异源要求、模拟演示和验收表述不覆盖冻结基线。根目录原启动命令改为 `dev:legacy`、`build:legacy`、`start:legacy`。

## Decision Desk 实现

本 PR 在 `decision-desk/` 中加入一个可运行的中文决策对账台。它使用真实 dsh `0.1.2-rc.1` 运行时，将人的要求、Agent 的选择、执行前冲突拦停、人工纠正、生成文件和验证结果串成可回看的记录。

- 双栏时间线对照人的要求与 Agent 行动，事件按颜色分类并支持筛选。
- 明确冲突在文件改动前暂停；支持纠正、原要求改正、仅本次放行和停止。
- 可随时追加新要求或参考想法；已完成任务也能基于现有文件继续，不重放旧工具。
- 成果独立宽屏展示，支持全屏、独立页面和实际交互。
- 支持 OpenAI-compatible Chat Completions 执行模型与异源审查模型，密钥不进入日志或浏览器。
- `decision-desk/` 内有完整运行说明、19 项单元／集成测试和 5 项浏览器验收测试。

原仓库的模拟实现、dsh 插件边界、回滚研究和 API 设计均保留；两套实现的差异和取舍见 [`decision-desk/README.md`](./decision-desk/README.md) 及 [`三种观点权衡与实现方案.md`](./三种观点权衡与实现方案.md)。

一个本地可运行的中文 Decision Stream 工作台：把每个粗粒度 step 对账为“人说了什么 / Agent 实际做了什么”，让人只处理需要判断的红卡，并把裁决、证据和过程回放沉淀成一页报告。

## 已实现（Implemented）

- 创建、选择和持久化多个 session；短 spec 必须确认后才能执行。
- session 创建时固定 `forward-only` 或 `rewind-and-fork`，页面明确显示且不能静默切换。
- 红卡约束冲突执行前阻断，支持放行、备选、自由改写、叫停；蓝卡不阻断进入侧栏；灰卡只进日志。
- 只有 executor 绑定的真实验证 evidence 才会变成 green；人工复核不会伪装成 green。
- 每个 step 双栏展示人类指令与 Agent 动作，tool call/result/evidence、judge/recorder 来源和置信度可展开。
- 全局 append-only timeline：agent、branch、event type 过滤，多 Agent 合并序列、来源、turn/step，支持上一步、下一步和自动播放。
- rewind-and-fork 保留父分支、显示 fork turn 和活动分支，并标示外部副作用不可撤销。
- 报告统计人的纠偏、前后文本、验证证据、运行重试/升级、记录漂移、未验证项和不可逆副作用；支持打印样式。
- “运行完整演示”不调用外部模型，稳定串起蓝卡 → 红卡阻断 → 当前模式纠偏 → tool execution → executor evidence → 回放/报告。
- JSONL append-only 持久化、重启恢复、pending gate 恢复为 `interrupted`、结构化 API 错误和本地路径安全边界。

## 模拟与限制（Simulated / Not implemented）

### Simulated

- deterministic judge 和 recorder 是本地 fallback，用规则模拟独立判官与异源记录员职责；它们不是模型自报，也不代表真实异源 provider 的准确率。
- 完整演示动作由 `LocalAgentExecutor` 在当前 workspace 执行，命令仅允许 `node --version`、`npm test`、`npm run typecheck`、`npm run build` 等小范围 allowlist。

### Not implemented

- 没有伪造 dsh 接入。`package.json.deepseekHarness` 只锁定目标版本 `0.1.3-alpha.1`，真实 `tools/pre-execute`、`agent.inject()`、`agent.cancel()` adapter 尚未安装。
- 没有接入真实异源模型；记录员 adapter 仍需接入独立 provider 并做准确率实测。
- 没有 Git workspace snapshot 或物理文件回滚。fork 只保留逻辑事件与分支血缘；邮件、网络请求、已运行命令等外部副作用不可撤销。
- 没有认证、多用户权限、远程部署或跨会话成长档案。

## 启动

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

打开 <http://127.0.0.1:4173>。开发时可用 `npm run dev`。

## 完整 Demo

1. 打开页面，选择 `forward-only` 或 `rewind-and-fork`。模式只对新 session 生效。
2. 点击“运行完整演示”。它会新建 session，确认一个短 spec，先执行蓝卡缓存选择。
3. SQLite 写入会在执行前成为红卡并保持 pending。演示按当前模式自动选择备选或改写。
4. `forward-only` 会追加未来约束；`rewind-and-fork` 会在完成的 turn 边界创建子分支，父分支保留。
5. 修正后的 schema 由本地 executor 写入，随后 `validate` 动作产生 executor evidence，卡片显示 green。
6. 在时间线使用过滤器和回放按钮查看多 Agent 来源、裁决和 tool result，在底部打印一页报告。

也可以手动操作：确认 spec 后提交 `/actions`，红卡用 `/cards/:cardId/decision` 裁决；不要把 demo 的临时写入当作生产数据。

## API

所有响应均为 JSON，失败格式为 `{ "error": { "code": "...", "message": "..." } }`。

- `POST /api/sessions`：创建 session，body `{ "mode": "forward-only" | "rewind-and-fork" }`
- `GET /api/sessions`、`GET /api/sessions/:id/state`
- `POST /api/sessions/:id/spec`
- `POST /api/sessions/:id/actions`、`POST /api/sessions/:id/demo`
- `POST /api/sessions/:id/cards/:cardId/decision`
- `POST /api/sessions/:id/verify`、`POST /api/sessions/:id/cancel`
- `POST /api/sessions/:id/rewind`、`GET /api/sessions/:id/branches`
- `GET /api/sessions/:id/timeline?agentId=&branchId=&eventType=`、`GET /api/sessions/:id/report`

## 安全边界

服务只监听 `127.0.0.1`，不开放 CORS，并拒绝非 loopback `Origin` / `Referer`。请求体限制 1 MiB，静态路径限制在 `public` 目录。默认 executor 对 workspace 相对路径做 containment 检查，拒绝任意 shell 文本；`args.external` 只会标记不可逆副作用。此边界不是身份认证，不能直接通过代理公开；生产接入仍需认证、CSRF/session token、沙箱 executor 和 workspace snapshot adapter。

## 两种模式

- `forward-only`：拒绝原动作并注入约束，只影响后续步骤；已经发生的事件和动作不改写。
- `rewind-and-fork`：只能从初始或已完成 turn 边界创建新分支；原分支完整保留，新分支带着人的指正重做。逻辑 fork 不撤销外部副作用。

## 测试范围

`npm test` 覆盖核心 gate、四种裁决、取消/超时 fail-closed、重试升级、记录 drift、证据变绿策略、并发多 Agent、分支 redo、JSONL 恢复和 HTTP session 隔离/错误/来源/路径校验；`src/ui-flow.test.ts` 覆盖完整演示阶段和 timeline 粗粒度分组。已验证命令：`npm run typecheck`、`npm test`、`npm run build`。

## 能力矩阵：dsh / 异源模型 / Git adapter

| 能力 | 当前状态 | 边界与验证 |
|---|---|---|
| dsh `tools/pre-execute` | 契约 + Mock smoke | 覆盖 pending、allow、deny；真实 runtime 未安装，不伪造接入 |
| deny reason | 契约 + 测试 | 原动作不改写，reason 作为 dsh deny 结果保留给模型/记录层 |
| `agent.inject()` | 契约 + Mock smoke | 只投递到 `next-admitted-request`，只影响未来，不改历史 |
| `agent.cancel()` | 契约 + Mock smoke | abort pending/running 语义；pending gate 必须收敛 |
| session / turn / step / fork events | 事件映射 + Mock smoke | fork 只接受已完成 turn boundary；父分支保留语义由 workspace/session adapter 承担 |
| unknown dsh events | 事件映射 + 测试 | 归一化为 `adapter-event`，保留 `externalType`、`provider`、`version` 和原 payload |
| dsh 真实运行时 | 未实现于主仓库 | 外部 checkout 的 `0.1.3-alpha.1` / `d347e70390` 已由插件真实复核；主仓库仍不把它作为必装依赖 |
| workspace 文件快照 | 未实现 | fork/文件恢复需要注入 `WorkspaceSnapshotAdapter`；dsh session fork 不等于磁盘回滚 |
| 外部副作用 | 仅记录限制 | 邮件、网络请求、已运行命令等不可由 fork 回滚 |
| 异源 recorder/model | 未实现 | 需要独立 provider adapter 与准确率实测，不由 deterministic fallback 冒充 |

需求文档将 DeepSeek Harness `0.1.3-alpha.1` 作为目标底座，但本仓库没有伪造不可安装包，也没有把它放入必装依赖。真实接入应由外部 dsh adapter 消费事件、在 pre-execute 阻断、用 inject 向前注入并由 cancel 叫停；异源 recorder 应独立消费事件流。物理 rewind 需要每个 turn 的 Git snapshot/worktree adapter。当前实现只提供这些接口和行为规约，不能宣称已完成真实 dsh、异源模型或 Git 回滚。

`src/adapters/dsh.ts` 是唯一的 dsh 接入边界：`DshAdapter`、`mapDshEvent()`、`MockDshAdapter` 和 `requireRealDshRuntime()`。生产 adapter 必须在该边界实现，不能把 dsh 类型散落进 core。
