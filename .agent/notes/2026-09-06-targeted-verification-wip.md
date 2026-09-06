# 针对性行为验证与显式继续：未完成接线记录（2026-09-06）

## 当前事实

首批已上线和准备提交的能力只有 `task-archive-v1` 与 `grill-batch-v1`。`verify_behavior`、纠正 supersede 和显式 continuation 尚未注册或对外暴露，不能写成已经实现，也不能据此把真实 Mario 的等待验证卡标绿。

行为检查 Host 模块由协作审查者完成在 `decision-desk/server/behavior-verifier.ts`，依赖为精确版本 `playwright-core 1.62.1`。它只运行白名单浏览器动作和机械观测/断言，阻断外部请求，记录入口与已加载本地产物哈希，失败或无法判断返回 failed/inconclusive；它本身不改 RunState。该文件与 package/lock 的校验快照在 `/private/tmp/kanzheban-behavior-verifier-wip-20260906T-current`。

显式 continuation 的 Manager/Engine 草稿已写过但为首批提交临时剥离，三文件完整快照在 `/private/tmp/kanzheban-continuation-wip-20260906/`：`manager.ts`、`engine.ts`、`types.ts`。恢复时必须以首批提交后的文件为基底，只恢复 continuation/行为相关差异，并保留后来授权的 ready(confirm) 可归档修复；不要整树 reset，也不要覆盖他人的前端变化。

## 仍需完成

1. 恢复 `POST /api/runs/:id/continue` 与 `explicit-continuation-v1`。它只接受 UUID requestId、当前 revision 和显式运行指令；completed/error/stopped/interrupted 且真实 runtime idle 时可启动，归档、并发、pending gate、未关闭单元拒绝。事件必须幂等，指令不进入 constraints、不增加 revision。执行提示动态列出当时全部尚未取得当前证据的 correct/enforce 纠正，不能写死八条。
2. 注册 `verify_behavior`，将 worker 场景先交独立 reviewer。reviewer 必须看到目标纠正、原决定、当前有效人类约束、场景和当前产物资料；只有相关且足以覆盖纠正时 classification=execution，其他结果直接拒绝，不能进入 allow-once 人工放行。
3. Host 实际返回 passed 后，只有 revision、入口哈希和全部 loadedArtifacts 哈希仍与当前文件一致，才写入独立 BehaviorVerification、真实事件并把对应 intervention 设为 verified。failed、inconclusive、取消都不得变绿。
4. 后续 write/edit/run_command 若改变任一绑定文件，证据标 stale，intervention 回到 acted；不能恢复旧哈希下的绿色。静态 verify_app 仍只陈述其狭窄覆盖。
5. 单独注册 supersede 工具：只能引用晚于原纠正的真实、active 人类约束 ID，经独立 reviewer 确认语义确实取代原纠正。结果为 superseded，不伪装行为验证 passed；被引用约束失效时 resolution 也应失效。
6. 追加持久化重放、幂等/取消/失效边界和前端 evidence/lane 展示；用既有测试、临时 fixture 和真实 Chrome Host 探针验证，不新增仓库测试文件或测试 case。

全部能力接好、再次确认生产 runtime idle 并安全部署后，才由产品原任务 worker 接收“处理当前所有未完成验证的纠正”的运行指令。我们和子代理不得直接修改 Mario 源码、代做场景或手工改绿。worker 修改文件会使同文件旧证据失效，必须对当前产物重新取得真实证据。原历史 append-only、任务 ID 不变、revision 仍按真实人类要求事件决定。

## 2026-09-06 额度暂停点

用户要求先处理另一项限定文件复制并推送，因此本接线在未完成状态暂停，绝不能纳入该次提交或部署：

- 首批已提交推送为 `a8d2e8330b9eb64d4b1caa1c3ad987269abe59d0`；本地 4322 的 PID 30515 仍只声明 archive/Grill 两项能力，未重启、未启动 Mario。
- WIP 的 package/lock 与 `server/behavior-verifier.ts` 已恢复；`server/manager.ts`、`server/engine.ts`、`shared/types.ts` 已从 continuation 快照恢复，并在 manager 重新保留 ready(confirm) 可归档的已上线修复。
- `shared/types.ts` 已有 BehaviorVerification、CorrectionResolution 和 superseded 类型草稿；`reviewer.ts` 已加入 verify_behavior/supersede_correction 专用独立审查提示；`engine.ts` 已加入 Host import、两工具 schema、执行/证据/失效 helper 及 write/run_command/revision 触发点。
- 当前仍缺：preExecute 对目标/文件/后续约束的确定性校验与 reviewer enrich；特殊工具非 execution 时直接拒绝且不得创建人工 allow-once gate；work-unit只读策略；Store 尾事件重放；app 恢复 continuation 路由/capability；行为 capability；前端接线；完整类型检查与探针。暂停前没有声称编译通过，当前中间源码可能存在类型错误。
- WIP 当前还包括 `server/reviewer.ts` 的未提交修改。恢复工作时先查看 `git status` 和本 note，不得用 reset 清掉 package/lock、behavior-verifier、manager/engine/shared/reviewer 或两份未跟踪保留说明。
