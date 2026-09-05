# 实时任务单元与“195 条记录”只读诊断

日期：2026-09-06。

## 现场与方法

只通过本机已认证只读 API 获取一条正在运行的任务 state/events，并在临时文件中按当前 `timelineGroups` 规则重放归组。没有读取或输出模型密钥、巨量原始正文，没有调用 stop/resume/verdict/additions，也没有重启或部署服务。

快照共有 28 个工作单元、108 个 state steps、995 条业务事件。

## 最后一个工作单元

- 单元状态为 `active`，计划包含两次修改和一次验证，`nextCall=0`。
- `begin_unit` 控制 step 已完成；第一项实际修改正在等待人处理，后两项计划调用尚未创建。

界面步数只统计已经创建、带该 `unitId` 且不是 `begin_unit` / `end_unit` 的动作，因此显示“1 步”与真实状态一致，不代表三步计划被截断。该单元自身归组 16 条事件。

## “195 条记录”的来源

这 195 条不属于最后一个工作单元，也不是发生在它之后。它是 `timelineGroups` 在所有单元之后追加的 `task-records` 全程汇总，最后一条早于最后一个工作单元。

按可解析归属分为：

- 49 条任务生命周期/人工全局事件：run、grill、constraints、gate、intervention；
- 70 条活动单元窗口之外的模型事件：35 `model.request` + 35 `model.response`；
- 25 条活动单元窗口之外的 `message`；
- 51 条关联到 12 个没有 unitId 的 step：12 `tool.proposed`、9 `review.started`、9 `review.completed`、9 `tool.allowed`、12 `tool.finished`。

12 个无 `unitId` step 中，9 个是单元开始前允许的准备性读取，另 3 个是单元外被拒绝或失败的调用。没有发现能够解析到带 `unitId` step 却落入该汇总的事件，也没有发现最后一个工作单元的事件混进 195 条汇总。

数据归属本身与当前规则一致；误解来自展示顺序和标题：任务级全程汇总被无条件追加在最后，看起来像是最后一个单元的后续。前端因此把它改为独立、紧凑的“任务记录”折叠区，不占用工作单元序号，也不暗示它发生在最后一个工作单元之后。

## 完成后的“等待验证 11”

稍后的只读快照中任务已为 `completed`、revision 3、lastEventSeq 1031。按当时前端 `boardItems` 源码重算得到 37 张卡：已验证 16、等待验证 11、已停止/拦停 10，没有正在推进或需要判断的卡。state 虽有 60 条历史 verification，当前产物只有 3 项最新检查；三项均绑定 `index.html` 当前 hash 和一个已完成的 `verify_app` step，均 passed 且非 stale。线上 v1 没有在这些 verification 中保存 revision 字段，前端依靠当前文件 hash 与已完成检查 step 判定它们仍是当前证据。

“11”是卡片数，不是还有 11 个检查任务排队：

- 8 张是历史纠正卡。人的状态为 corrected，原动作 denied，相关单元 cancelled；后续已有文件改动，但 intervention 只停在 `acted`。当前后端仅为内存/刷新/持久化这一项特殊规则自动推进 `verified`，一般语义纠正没有针对性验证关联。最终三项静态检查不能证明隐藏块物理、关卡布局或敌人位置等语义已经按纠正完成，所以这 8 张不能仅凭同文件当前 hash 自动变绿。
- 1 张来自已取消的 choice 单元。单元只有完成的控制 step 和 denied 的修改；旧 decision 卡归类没有读取 unit.status，因此误落到等待验证。这是确定的展示归类问题，应进入已停止/拦停。
- 2 张是人已 `allowed-once`、动作 done、单元 completed 的卡。所在单元已有当前 hash 检查，但旧覆盖分支只给 execution/choice classification 取检查，导致原 review 为 conflict/uncertain 的两张卡检查数组为空。这是确定的覆盖遗漏；可使用各自完成单元的当前 hash 证据进入已验证，同时绿色仍只代表列出的静态检查范围。

前端只修复后两类确定性归类，不把那 8 张一般语义纠正伪装成已经验证；预期卡数变为已验证 18、等待验证 8、已停止/拦停 11。
