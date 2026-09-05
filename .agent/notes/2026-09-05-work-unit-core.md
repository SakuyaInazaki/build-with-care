# Work Unit Core

日期：2026-09-05

## 范围

本次接管只修改了 `src/types.ts`、`src/judge.ts`、`src/stream.ts`、`src/llm/units.ts`，新增 `src/work-unit.ts` 与本记录。没有修改 server、public 或 dsh plugin，避免与其他并发工作线冲突。

## 兼容模型

- 旧 `execute(action)` 保留，继续提供 action 级 API 和旧测试语义。
- 新 `executeUnit(unit)` 为一个语义目标创建一张卡；决策、匹配结果和多个工具调用都挂在 `card.unit`。
- `executeInUnit(unitId, action)` 将后续工具调用追加到同一张单元卡。
- recorder 的 drift 只写入 assessment/failure 记录，不改变放行结果。
- 结构化 constraint match 是独立 policy gate。只有 `forbidden` 与 `required-mismatch` 是红色硬冲突；`prefer` 和无约束是蓝色，不阻断。

## 证据边界

`ActionInput.specified` 和结构化决策中的 `specifiedByHuman` 都是 agent 输入，不能单独证明人类指定。判定只在真实 spec/constraint 文本能确认选择时产生 `human-specified`；硬约束匹配优先级高于自报字段。

单元内工具调用会再次抽取已知技术选择。未申报且命中明确 forbid/require 的调用由 policy safety net 阻断，并在 `UnitToolCall.safetyNet` 及 failure event 中记录 `source: policy-safety-net`。这不改变 recorder drift 的非阻断语义。

## 生命周期与修复

- 单元在 begin 阶段递增 turn/step 并创建一张卡，在 execute 阶段按序产生 `tool-call`、`tool-result`，结束时产生一个 `turn-end`。
- executor 即使忽略 AbortSignal，取消后返回的迟到成功也不会覆盖 cancelled 状态。
- `session-end` 写入终态事件后冻结追加事件；重复 `end` 和重复 session cancel 不产生重复记录。
- `validate` 只有在受控 executor 确认 target 存在时才产生 passed evidence；缺少 target 或目标不存在返回失败，不接受 agent 自报 `validationPassed`。
- report 的颜色桶互斥：verified 只计 green，failed 只计 failed，其余按 verdict 颜色计数。

## 已知边界

安全网发现冲突后会将单元置为 pending/red，当前公共 API 已返回 blocked 结果；若需要让安全网冲突像初始红卡一样等待 HTTP 人审，需要后续在线路协作稳定后把动态 gate 抽成共享 helper。server 路由和 LLM runner 尚未切换到 `executeUnit`，因此本次不触碰它们。

## 验证

已运行：

- `npm test -- --run src/stream.test.ts src/llm/judge.test.ts`：27 tests passed。

结果：`npm test` 通过（12 个文件、78 tests），`npm run typecheck` 通过，`npm run build` 通过。
