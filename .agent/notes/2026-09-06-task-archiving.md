# 任务归档与恢复（2026-09-06）

## 授权与目的

用户在 2026-09-06 明确提出“任务是否可以归档？添加功能”。本次增加的是可逆的任务整理能力，不改变任务执行结论，也不删除记录或成果。

## 后端契约

- `RunState.archivedAt?: string` 是唯一新增的任务归档状态。归档与恢复不改变 `status`、`revision`、约束、决定、验证、文件或原始记录。
- `POST /api/runs/:id/archive` 接收 `{ requestId: UUID, archive: boolean }`，成功返回完整 `RunState`。
- 实际归档追加 `run.archived`；实际恢复追加 `run.restored`；新的请求对已经处于目标状态的任务追加 `run.archive-unchanged`。同一 `requestId` 重试不再追加事件；同一标识改用于相反操作返回 `409`。
- `archivedAt` 使用第一次实际归档时间。重复归档不会更新它。恢复后删除该字段；再次归档会获得新的实际归档时间。
- `GET /api/bootstrap` 继续返回全部任务，包括归档任务及其 `archivedAt`，并声明 `backendVersion: unified-work-units-v4`，并在 `capabilities` 中声明 `task-archive-v1`（同版后续也声明 `grill-batch-v1`）。默认隐藏和归档列表由前端据此组织。

## 允许与拒绝

- `ready` 任务即使停在未确认 Grill 也可归档；归档与恢复保留原 Grill、状态和要求，恢复后仍须完成原确认才能执行。`running`、`waiting`、`stopping`，待处理 gate，正在 Grill/继续切换，以及底层 runtime/恢复调用仍在收尾时拒绝归档。
- 归档后仍可读取任务状态、工作单元、事件、事件详情、摘要、导出和成果文件。
- 归档后拒绝开始、继续、恢复执行、重试审查、裁决、补充要求或想法、停止、重新检查、Grill 推进和反思修改，统一提示先恢复任务。
- 恢复不受原运行状态限制，恢复后保留同一个任务 ID、运行状态、要求版本、文件和历史。
- 物理删除维持既有显式确认语义；归档不会替代删除，也不使删除不可用。

## 持久性与故障恢复

归档事件先持久化，随后保存状态快照。若进程在两步之间中断，`Store.loadAll()` 会从事件尾部重放 `run.archived` 或 `run.restored`，恢复 `archivedAt` 的真实状态。记录和工作区仍保存在原任务目录。

## 验证

未增加测试文件或测试用例。

- `./node_modules/.bin/tsc --noEmit`：通过。
- `./node_modules/.bin/prettier --check shared/types.ts server/manager.ts server/store.ts server/app.ts server/engine.ts`：通过。
- 既有后端测试：11 个文件、62 项全部通过。测试需要本地回环 mock server，因此在允许回环监听的环境重跑；受限沙箱内的首次运行仅因 `listen EPERM` 超时，不是产品断言失败。
- 临时 Manager 探针：覆盖活动状态、pending gate、终态但 runtime 仍收尾的拒绝；归档/恢复重启持久性；同请求与新请求幂等；归档后 7 个 Manager 变更入口拒绝；ID/状态/revision/文件保持。用户随后明确要求空闲的待确认任务也可整理，`ready` + 未确认 Grill 的归档/恢复已另行验证并保留原状态。
- 临时 API 探针：归档与恢复为 `200`；归档后验证、恢复执行、追加、停止、反思为 `409`；状态、事件、导出和成果读取为 `200`；能力信号为 `task-archive-v1`。
- 所有临时探针文件和临时数据目录已清理；探针期间未接触或归档真实 Mario 任务。

## 本地上线结果

首批本地服务已在确认没有 running/waiting/stopping、实际 Grill 请求或上游执行连接后更新。bootstrap 返回 `unified-work-units-v4`，能力仅为 `task-archive-v1` 与 `grill-batch-v1`；尚未完成的行为验证与显式 continuation 没有注册或对外暴露。ready(confirm) 入口修正后二次切换前后，三条真实任务的 ID、status、revision、文件清单摘要、事件序号和 Grill 状态逐项一致，公开设置摘要一致；没有自动开始、恢复、验证、裁决、补充、归档或 Grill 操作。首页与原 Mario 成果认证读取均返回 200。

这是本地已验收能力的阶段更新，不是剩余语义验证或冻结基线的最终认证。
