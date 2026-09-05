# 任务归档独立验收

日期：2026-09-06。

## 范围

本轮只验收 `task-archive-v1` 候选实现，没有修改归档业务代码，没有新增测试文件或测试用例，也没有操作真实任务、Mario 任务或其私有备份。后端探针使用一次性临时数据目录和临时端口，结束后已删除；前端检查使用内存 fixture。

## 后端证据

- bootstrap 返回 `unified-work-units-v4` 和 `task-archive-v1`；前端与后端实际请求体一致，均为 `{ requestId, archive }`。
- 一条临时 completed 任务归档前后保持相同 ID、status、revision、文件清单、要求、步骤、决定、人工记录和验证记录；已有事件保持原前缀，只追加真实归档生命周期事件。
- 归档状态下仍可读取任务、事件及 HTML 成果。reflection、verify、resume、additions、start、grill、stop、retry-review、verdict 九类写入或执行入口均返回 409，拒绝后状态和事件序号不变。
- running/waiting/stopping、待处理 gate、实际 Grill 请求进行中及内部执行仍在收尾的临时任务均拒绝归档。用户随后指出空闲的待确认任务也需要整理；追加探针确认 `ready(confirm)` 可归档、重载和恢复，原 status、Grill 与 revision 保持不变。
- 同一 request ID 重试归档或恢复不追加重复事件；用同一 request ID 请求相反操作返回 409。归档后重建 Manager/HTTP server 仍保持归档；恢复后保持同一 ID 和原状态，再次重建仍保持已恢复。
- 成果内容在归档、恢复及两次重载后保持不变。临时目录已清理。

## 前端证据

- 默认与最近列表排除归档任务，归档入口与计数单列；旧后端没有 capability 时不显示归档入口。
- 归档详情仍可进入看板、成果、活动和判断记录；执行、补充、复盘保存、重新检查等控件被隐藏或禁用。物理删除按产品决定保留原有输入确认流程。
- 归档任务不产生待处理通知，也不触发返回用户的自动欢迎页跳过。
- 使用 8 张一般语义纠正卡的 fixture 对比前后 `boardItems`，完整结果、lane、人工状态和 evidence 均一致，计数始终为等待验证 8。`archivedAt` 只作列表元数据和写入保护，不参与卡片分栏。
- `run.archived`、`run.restored` 和 `run.archive-unchanged` 显示为明确的任务级标题与说明，归入独立“任务记录”，不占工作单元序号，也不改变决策卡。

归档功能通过本轮候选验收。该结论只覆盖上述归档边界，不代表剩余语义验证已完成，也不是冻结首版正式认证。
