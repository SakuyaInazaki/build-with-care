# Agent Notes · 2026-09-05 · 最终验收修复

## 改动

- 为 `/api/sessions/:id/demo` 的预置红卡固定 `id: demo-red`，与 UI 完整演示和 README 约定一致。
- `DecisionStream.runExecutor()` 捕获 executor rejected Promise，将其按普通 runtime failure 重试最多三次并收敛为 failed/blocked-help，保证 gate 不会永久 pending；仍保留每次失败和最终 turn-end 事件。
- 约束注入统一去重；rewind 分支的 injection 事件现在也持久化 constraint，恢复时不会把同一条约束重复加入 spec。
- `LocalAgentExecutor` 对已存在路径和已存在父目录做 realpath containment 检查，拒绝通过 workspace 内 symlink 写入 workspace 外部。
- 根目录增加 `/db.sql` 和 `/db.sqlite` 忽略规则，避免本地 smoke/demo 生成物污染工作区；验收结束时删除了确认属于测试/demo 的根目录 `db.sql`、`db.sqlite` 及本次 smoke 生成的 schema 文件。
- 新增 executor rejection、恢复去重、demo card identity 和 symlink containment 回归测试。

## 原因

- 这些问题分别会造成 API/UI 演示链路不一致、未处理 Promise 导致任务永不结束、重启后状态漂移和路径边界绕过；不是为了追求表面全绿的测试调整。

## 影响与限制

- `/demo` 仍只启动预置红卡，不替代浏览器端完整演示编排；人工裁决仍需通过 card decision API。
- executor 的 runtime failure 仍最多自动重试三次；真实 dsh、异源记录员和物理 workspace snapshot 仍未接入。
- realpath 检查防止 symlink escape，但 workspace 本身仍是本地进程权限范围，不是沙箱；删除仅限确认属于本次/既有测试 demo 的生成物，未清理其他未跟踪源码和文档。

## 验证

- `npm install`：成功；npm 报告 5 个 audit vulnerabilities，未执行破坏性修复。
- 基线 `npm run typecheck`、`npm test`（28/28）、`npm run build`、`git diff --check`：均通过。
- 修复后将再次运行同四项命令，并执行独立 HTTP smoke，覆盖 session 隔离、spec、demo、红卡逐卡裁决、两种模式、timeline、branches、report、verify evidence、错误码、路径穿越。
