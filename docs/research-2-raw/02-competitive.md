# 竞品复查:「运行中决策层」空白是否成立

> 二轮调研原始结果 · 2026-09-04

## 总结论(先行)

**空白基本成立,但需要收窄表述。**「没有任何产品做过」原文过强——正确的说法是:**没有产品把「决策/假设」(而非 tool call)作为运行中的一等审查对象,并配套「翻案只向前生效」+「翻案日志=贡献证明」的完整闭环**。三个机制各自都有邻近物,但没有一个产品同时占住 ①+②+③,且所有邻近物审的都是「动作」或「计划」,不是「agent 替你做掉的假设」。

---

## 逐项排查

### 1. HITL 基础设施类 —— 审的都是 tool call / action,不是假设

| 项目 | 一行判断 | ①决策卡片 | ②向前翻案 | ③翻案日志 |
|---|---|---|---|---|
| **HumanLayer** | `@require_approval()` 装饰在高危函数上,审批对象是 function call 本身,无决策抽取 ([producthunt](https://www.producthunt.com/products/humanlayer)) | 低 | 无 | 无 |
| **gotoHuman** | 可自定义 review form + Agent Inbox,表单字段可承载任意内容(理论上可装假设),但产品定位是「审批动作/内容」,无自动决策抽取 ([gotohuman.com](https://www.gotohuman.com/)) | 中低 | 无 | 弱(有审批记录) |
| **Permit.io Access Request MCP** | 权限视角:agent 请求敏感权限、人批准,是访问控制不是决策审查 ([docs](https://docs.permit.io/ai-security/access-request-mcp/overview/)) | 无 | 无 | 弱(审批事件) |
| **LangGraph interrupt / LangChain Agent Inbox** | interrupt 暂停等人 accept/edit/respond/ignore,对象是 action args;Agent Inbox 是 Gmail 式审批 UI ([agent-inbox](https://github.com/langchain-ai/agent-inbox)) | 低 | 部分(见下) | 无 |
| **CopilotKit + AG-UI** | 协议层支持 agent 把「proposed action/state」推到前端、人 approve/modify——是最通用的载体,但协议不定义「决策」语义,需自己建 ([docs.ag-ui.com](https://docs.ag-ui.com/concepts/state)) | 中(可搭建) | 无 | 无 |
| **Composio** | 「safe breakpoints」暂停展示 plan/action 等审批,+ 执行日志;仍是动作审批 ([composio.dev](https://composio.dev/content/11-problems-i-have-noticed-building-agents-(and-fixes-nobody-talks-about))) | 低 | 无 | 无 |
| **OpenAI Agents SDK / AgentKit** | `needsApproval` + guardrails,暂停 run 等人批 tool call,resume 同一 run ([openai docs](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)) | 无 | 无 | 无 |

**关键区分点**:LangGraph 的 time-travel 是「回滚到 checkpoint、改 state、fork 新时间线重跑」([langchain docs](https://docs.langchain.com/oss/python/langgraph/use-time-travel))——这是 **rewind-and-fork**,恰好是机制②的反面(我们是不回滚、已产出保留、翻案只影响后续)。这个对比本身可以写进差异化论述。

### 2. Assumption / decision surfacing —— 只有日志库和博客技巧,无产品

| 项目 | 一行判断 | ① | ② | ③ |
|---|---|---|---|---|
| **agent-decision-log** (GitHub, MukundaKatta) | 结构化记录每个分支点的 options/chosen/rationale,**明确自述"只观测不拦截"**,replay 是离线 A/B 不是翻案 ([repo](https://github.com/MukundaKatta/agent-decision-log)) | 高(数据模型撞车) | 无 | 无 |
| **Addy Osmani「Automated Decision Logs」** | 纯 prompt 技巧(让 AI 往 fyi.md 里写决策),事后人工看,非产品 ([blog](https://addyosmani.com/blog/automated-decision-logs/)) | 中(理念撞车) | 无 | 无 |
| **CHAP 协议** (Brightbeam AI, arXiv 2606.09751) | 学术协议提案,定义了 `decide.override` 事件(人改 agent 产物并记录为 override artefact)——**理念上与①③最接近,但是纸面 spec,无产品** ([arxiv](https://arxiv.org/pdf/2606.09751)) | 中 | 无 | 中 |
| **Narmi AI DecisionAssist** | 银行开户审核域:AI 出 recommendation card、人 approve/deny、override 必须写备注且反哺模型——**卡片+翻案+记录三件套都有,但方向相反**(AI 辅助人决策,不是人监督 agent 运行),且是金融垂直域 ([narmi.com](https://www.narmi.com/insights/introducing-ai-decisionassist-tm-the-manual-review-workflow-rebuilt-inside-narmi)) | 中 | 无 | 中 |
| **Imbue Sculptor** | 并行 coding agent UI,运行中自动**flag 问题**(假测试、违反 claude.md、硬编码)+ 自然语言规则审计——是「issue surfacing」不是「decision surfacing」,surfaced 的是错误不是替你做的选择 ([imbue.com](https://imbue.com/blog/sculptor)) | 中低 | 无 | 无 |
| 观测类(AgentOps/Galileo/OTel 等) | 只读 trace,与一轮调研结论一致,无审批面 | 无 | 无 | 无 |

### 3. 一线 coding agent 2025-2026 更新 —— 事前问,不事中亮

| 产品 | 一行判断 | 重叠 |
|---|---|---|
| **Claude Code `AskUserQuestion`** | agent 在**不确定时主动发多选题**问人,而非「先做了再浮出来」;方向是 pull(agent 问)不是 push(决策被抽出展示);60 秒超时后自行继续 ([guide](https://www.atcyrus.com/stories/claude-code-ask-user-question-tool-guide)) | ①中低——最接近的心智,但触发权在 agent,漏掉的假设永远不会被问 |
| **Cursor 2026** | Plan Mode 前置 clarifying questions;有 checkpoints+rollback(rewind 式,非向前生效)和 mid-task clarifying questions(后台继续干活) ([breakdown](https://chatgptaihub.com/what-s-new-in-cursor-2026-full-breakdown-for-developers/)) | ①低 ②反向(rollback) |
| **Devin** | "Wait for my approval" 计划审批门,官方自己说 plan review 是最高杠杆检查点——**事前**;运行中靠自由文本打断转向(算隐式向前生效,但无结构化决策对象、无日志) ([docs.devin.ai](https://docs.devin.ai/release-notes/2025)) | ①低 ②弱隐式 ③无 |
| **Codex / Windsurf / Copilot** | 未发现决策点确认功能;审批仍停留在命令/写操作层 | 无 |
| **Factory.ai** | 可调 autonomy + 人保留 merge 权,无决策抽取 ([factory.ai](https://factory.ai/news/code-droid-technical-report)) | 无 |

### 4. Approval fatigue 的可借鉴设计

- **WorkOS**:「审批疲劳是 agent 治理的下一个攻击面」——虚假监督比无监督更糟;主张按风险+领域路由审批而非单一队列 ([workos.com](https://workos.com/blog/approval-fatigue-agent-governance))
- **三档分层**是业界收敛解:Tier 1 auto-approve(低风险可逆)/ Tier 2 notify(非阻塞+撤销窗口)/ Tier 3 blocking approval(不可逆高危)([agentsyncx](https://agentsyncx.com/blog/ai-agent-approval-workflow-best-practices));Gartner 2026.5 也点名「所有 agent 用同一审批流程」是根因,提出四档自治分级
- **可直接借鉴**:决策卡片默认走 Tier 2(非阻塞浮出+事后可翻案)正好绕开审批疲劳——这是机制②相对 blocking approval 的天然卖点,且有现成文献背书

### 5. Bloop / Vibe Kanban 核实

**属实**。2026-04-10 官方宣布关停公司(免费用户占绝对多数、找不到商业模式),Vibe Kanban 转社区维护开源(Apache 2.0),云功能 30 天后下线、本地功能保留 ([vibekanban.com/blog/shutdown](https://www.vibekanban.com/blog/shutdown), [创始人推文](https://x.com/tokengobbler/status/2042647208135123078))。

---

## 精确边界与差异化

**空白的精确表述**:现有所有运行中 HITL 的审查对象是「**agent 想做的动作**」(tool call / plan / state patch);没有产品把「**agent 已经替你拍板的假设/取舍**」自动抽取成结构化卡片、允许非阻塞地事后翻案、翻案只向前生效且沉淀为人的贡献记录。三机制中:

- **①决策卡片**:数据模型层面已有人做(agent-decision-log 的 options/chosen/rationale 六字段),但无人接上「人可交互」;卡片 UI 形态在别的域出现过(Narmi,方向相反)。①单独不构成壁垒,**①+可翻案才是**。
- **②翻案只向前生效**:完全空白,且现有技术栈(LangGraph time-travel、Cursor checkpoints)全走 rewind-and-fork 路线——可以明确对立表述:「不重跑历史、不作废已产出,只修正未来」。
- **③翻案日志=贡献证明**:观念在合规文献和 CHAP 协议里出现(override 作为 artefact 记录),但无人把它做成「人的贡献归因」产品;与 Cursor Blame/git-ai 的「行级归因」互补而非撞车(它们归因代码行,我们归因决策)。

**最需要在 pitch 里主动防守的三个邻近物**:Claude Code AskUserQuestion(答:触发权在 agent、pull 模式、阻塞式)、LangGraph time-travel(答:rewind vs forward-only)、Sculptor(答:surface 的是 bug 不是 decision)。
