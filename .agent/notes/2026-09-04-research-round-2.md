# Agent Notes · 2026-09-04 · 二轮调研与赛题拆解

> 记录人：芝士（AI）。本条记录本次工作会话做了什么、怎么做的、哪些是 AI 判断、哪些待人确认。

## 本次会话完成的工作

### 1. 赛题深读 → `docs/track3-breakdown.md`

- 通读 `docs/info.md`，把赛道三拆成：两层含义（管得住 / 人变强——后者是出题原因）、硬边界对照表、四方向取舍、提交倒排（9/6 12:30 冻结，约 43 小时）、2 分钟路演动线。
- **AI 判断（待人确认）**：四方向取舍建议——主攻方向一、顺带吃方向三、方向四降为副产物、方向二只进 roadmap。

### 2. 二轮调研（四路并行子任务，基于 research.md 的缺口）

派了四个并行调研分身，已回三路，原始结果按路落盘：

| 路 | 文件 | 一句话结论 |
|---|---|---|
| 技术可行性 | `docs/research-2-raw/01-technical.md` | ✅ 三机制通道全部存在。PreToolUse 可拿全量输入、可阻塞、可 deny+理由回传；注入天然只向前；推荐路线 A（CLI+hooks+本地审批 UI，1 人日跑通）。两个 Day1 必做实测：ExitPlanMode 的 plan 字段、PostToolUse additionalContext。⚠️ hook 超时 fail-open 是最大工程风险。 |
| 竞品复查 | `docs/research-2-raw/02-competitive.md` | ✅ 空白基本成立但需收窄表述：所有现有 HITL 审的是"动作/计划"，无人审"agent 替你拍板的假设"；机制②（向前翻案）完全空白，现有全走 rewind-and-fork 反路线。Bloop 关停属实。路演需防守三个邻近物：AskUserQuestion / LangGraph time-travel / Sculptor。 |
| 中文社区 | `docs/research-2-raw/04-chinese-community.md` | 痛点与英文圈一致且更尖锐（面试/绩效焦虑形态）；社区已有散装土办法（提示词硬约束、RFC 机制、ADR 前置）但无产品化；国内产品（CodeBuddy 等）只做到计划级审批，决策级是空白。 |
| 引用核实 | （进行中，未回） | 核对 HiL-Bench / AGDebugger / 400行阈值 / context rot / 缓存注入 等路演引用的原文准确性。 |

- 待办：第四路回来后写汇总 `docs/research-2.md`（含更新后的方案建议与风险清单），预计再提交一次。

### 3. `docs/pre-discussion.md`

- 按要求建立的**空白**讨论文档，内容留待需求对齐讨论时填写。
- 教训记录：AI 曾自作主张填入了一版"待对齐问题清单"，被指出后已清空。原始需求文档的内容应由讨论产生，不由 AI 预填。

## 过程与方法说明（透明度）

- 四路调研均为并行子任务，各自用 WebSearch/WebFetch 独立检索，结论附来源 URL；原始输出未经删改落盘到 `docs/research-2-raw/`（仅格式整理）。
- 竞品复查的任务设计是**证伪式**的（"尽力找到已经在做这件事的产品"），以降低确认偏误。
- 中文社区一路明确要求"检索不到就如实说明，不要编造"；知乎正文 403 未抓到，已在文内注明。
- 技术可行性一路发现两处文档互相矛盾（PostToolUse additionalContext），未武断取一边，标为开工首日实测项。

## 环境备注

- 工作沙箱内另装了赛事仓库自带的 grill-me 技能（装在工作区 `.claude/skills/`，不在本仓库内），供需求对齐讨论用。
- 本仓库工作全部在 `docs/` 与 `.agent/notes/` 内进行。
