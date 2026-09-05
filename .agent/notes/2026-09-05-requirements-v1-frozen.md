# 需求冻结记录

**日期：2026-09-05**

## 本次操作

- 只新增 `docs/requirements-v1-frozen.md`，记录本次逐项人工确认并冻结的首版需求。
- 只新增本 note，记录本次文档变更。
- 未修改原三份 requirements：`docs/requirements-alignment.md`、`docs/requirements-alignment-S.md`、`docs/requirements-alignment-Y.md`。
- 未修改任何代码、配置、测试或现有契约文件。
- 未提交 commit。

## 为何不覆盖原三份 requirements

三份 requirements 是平权来源，包含不同讨论参与者和不同阶段的决策轨迹；它们需要保留以便追溯，不能通过覆盖来抹去历史。新增冻结文档作为首版实现与验收基线，明确本次人工确认的收敛语义，并规定冲突时以冻结项为准。`api-contract-v2.md` 与 `work-unit-design.md` 仍作为实现背景和契约来源保留，未在本次文档工作中改写。

## 本次核对修正

- 修正冻结文档的红卡四项，使用已确认的业务语义，并以括号保留对应内部 API 命令，避免命令名替代业务语义。
- 修正 B3 评测，使其按同四项业务语义及各自验收行为验收。
- 修正人机沟通边界：需求澄清走工作台 Grill，运行中干预走决策流卡片，均不得走 `dsh ask_user_question`。
- 仅核对并修正上述明确错位，未修改其他文件，未提交 commit。
