# 中文社区调研：开发者与 AI Coding Agent 协作痛点

> 二轮调研原始结果 · 2026-09-04
> 调研方式：WebSearch 多组中文关键词（含 site:v2ex.com / site:sspai.com 限定），对高价值帖子用 WebFetch 抓取原文。知乎问题页返回 403 无法抓正文，仅能确认问题存在；其余来源均抓到了原文。

## 1. 真实痛点言论（可作路演素材）

### ① 看不懂 / 来不及审 agent 的大段改动

- **[V2EX：用 AI 写代码时，你们还逐行看代码吗？](https://www.v2ex.com/t/1224238)**
  - 网友 lujiaosama：**"代码量少的看，一大坨的看不了一点"**
  - 网友 wyfig：**"一天几千行上万行的，看的过来？"**
  - 网友 NQ：**"看的越多 git reset 越多"**
  - 主楼作者的妥协："代码我可以不懂，但业务结果我必须懂"——已放弃逐行审查，改为只验收业务结果。
- **[虎嗅：AI 太会写代码，人类已经审不过来了](https://www.huxiu.com/article/4869850.html)**
  - **"5 分钟生成 1000 行代码，40 分钟才能勉强审完"**；开发者花在"审查、调试、修改 AI 代码上的时间，已经超过了以往自己动手编写的时间"；cURL 创始人因无力处理 AI 生成的低质量漏洞报告而关闭漏洞赏金计划。
- **[Chico's Tech Blog：AI 写的代码，谁来审](https://realtime-ai.chat/posts/coding-agent-review/)**
  - **"写代码这件事，被 AI 解决了一大半。审代码这件事，一点没变。瓶颈就这么从『写』挪到了『审』"**
  - 审查为何更难的三个原因："它看着太合理了"（AI 的错误代码长得和正确代码一模一样）、量的压力（日审 5-6 个 PR 变 10+）、**"意图断了"（diff 里缺失"为什么"的推理链）**。
- **[掘金：当 AI 一天写完一周的代码，我们还剩什么优势？](https://juejin.cn/post/7670092136001060907)**
  - **"代码审查（Code Review）和代码归属权（Code Ownership）成了整个研发流程里最大死角。"**
- **[V2EX：让 ChatGPT review Claude 写的代码](https://www.v2ex.com/t/1221653)**：网友 hez2010："Claude 写的代码里很容易有各种奇奇怪怪的 bug，而且修复 bug 也不去找根本原因"；主楼："当 AI 几乎挑不出错，真正的难题不再是找 bug，而是知道什么时候该停"。

### ② agent 静默替人做架构 / 选型决定

- **[V2EX：ai 编程老乱动代码怎么办](https://www.v2ex.com/t/1112737)**
  - 主楼：让 AI 完善某个功能，AI **未经要求直接改了 UI**；"这似乎是 ai 编程通病？"
  - 网友 radishzz 的土办法提示词（原话）：**"请记住，没有我的允许，不要修改我的文件！请仔细思考，有哪些解决方案？哪个方案最合适？请直接展示你的解决方案，并说明修改了什么？原来是什么？"**——本质上就是手工版"决策确认"。
- **[陈广亮博客：接手 AI 写的代码后我心态崩了](https://chenguangliang.com/posts/blog197_vibe-coding-maintenance-real-test/)**（静默决策的"事后代价"，路演金句密集）
  - **"你成了自己代码的陌生人"**
  - **"你对这段代码为什么这样写没记忆，对当初有哪些方案 AI 没选没认知"**——这正是"AI 静默做了选型、人类没参与"的直接后果。
  - "到第 3 个月时诡异 bug 越修越多，因为修 A 撞 B，两者共享了 **AI 隐式假设的状态**"；"写得有多爽，维护就有多崩"。
- **[小灰灰的笔记：多 Agent 协作](https://www.tinyash.com/blog/gojaja-multi-agent-coordination-how-to/)** 也点名"信息孤岛：某个 Agent 做出的**架构决策**其他 Agent（和人）不知道"。

### ③ 多人多 agent 协作冲突

- **[小灰灰的笔记：多个 AI 编程 Agent 在同一项目协作总是冲突](https://www.tinyash.com/blog/gojaja-multi-agent-coordination-how-to/)**
  - **"前端 Agent 和后端 Agent 同时修改同一个接口文件，Git 冲突成了日常"**；三大困境：任务冲突、决策信息孤岛、**无法审计**（决策过程和变更无法追溯）。
- **[V2EX：5X 的 Codex 一天半烧完了，晒晒我的智障多 agent 工作流](https://www.v2ex.com/t/1238942)**
  - 主楼：10 个分工 agent 一天半烧光额度，"钱主要烧在上下文上。每个 agent 都得喂历史记录"；评论区：**"AI 评审就是智障互相骗"**；社区共识是要人来做每个阶段的验证与决策，而非 agent 委员会。
- **[jsjson：Git Worktree + 多 Agent 协同开发实战](https://www.jsjson.com/blog/parallel-ai-coding-worktree-guide)**、[知乎：VS Code 多 Agent 并行工作流](https://zhuanlan.zhihu.com/p/1995797732405833855)：解决思路集中在 worktree 隔离、feature 目录隔离、"接口先行作为多个 Agent 的契约"。

### ④ vibe coding 之后说不清自己贡献了什么

- **[掘金：当 AI 一天写完一周的代码](https://juejin.cn/post/7670092136001060907)**：代码归属权成"最大死角"；大厂考核已"不是看你用 AI 输出了多少行代码，而是看你能否在代码暴增 8 倍的情况下守住系统稳定性"。
- **[微信公众号：鹅厂面试官问我"现在都是 Vibe Coding，那你的优势是什么？"](https://mp.weixin.qq.com/s/TD4QN-14GGTWdUHK5E9Dxw)** 及 [知乎同主题文章](https://zhuanlan.zhihu.com/p/2036091840148005434)：面试者答"AI 写不了复杂业务"被面试官当场否定——"说不清自己价值"的焦虑已进入招聘场景。
- **[ruanyf/weekly #8254：Vibe Coding 时代的面试](https://github.com/ruanyf/weekly/issues/8254)**："我们组的面试从写 leetcode 变成实现完整功能，不用 AI 根本完不成"；理想候选人是"在 AI 开始工作前会预判 AI 会在哪里改代码，写完后立即验证"——能**说清并证明自己驾驭了 AI**成为新的能力凭证。
- **[CSDN：Linus 为 AI 代码"立法"](https://blog.csdn.net/csdnnews/article/details/160158710)**：Linux 内核规则"允许用 AI，但锅必须人背"——谁提交谁负责，倒逼开发者必须能解释 AI 代码。
- **[80aj：开发者真的"拥有"这些代码吗？](https://www.80aj.com/2026/08/31/ai-code-ownership/)**：从法律角度讨论生成代码的贡献认定。

## 2. 中文社区的"土办法"（类似决策卡片 / 假设确认）

确实存在，且形态多样，但都是散装自制，没有产品化：

1. **提示词硬约束**（[V2EX 1112737](https://www.v2ex.com/t/1112737)）："没有我的允许不要修改我的文件，先展示方案、说明改了什么/原来是什么"——手工版逐次决策确认。
2. **gojaja 的 RFC 机制**（[tinyash](https://www.tinyash.com/blog/gojaja-multi-agent-coordination-how-to/)）：给每个 agent 分配角色 + `--owns` 写权限边界，**跨角色决策走 RFC 记录、沉淀为 Git 可追踪文件**——最接近"决策卡片"的中文自制方案。
3. **ADR / BDD / PRD 可执行规格**（[觉醒AI](https://www.jxxy.net/ai/articles/bdd-adr-prd-decisions-humans-ai/)、[CSDN ADR 文章](https://blog.csdn.net/weixin_63764436/article/details/162753924)）：核心主张"**ADR 在代码之前——先确认决策，再实现**，别把 ADR 变成事后合理化"；用 lint/CI 违规时链接回决策文档，迫使 AI 读理由再改；定期"ADR 健康检查"审视"哪些**假设**已不成立"。
4. **规范契约文件**（AGENTS.md / CLAUDE.md / spec 文档，见 [掘金](https://juejin.cn/post/7670092136001060907)、[少数派 101833](https://sspai.com/post/101833)）：把技术栈决定、边界写进机器可读文件，让工程师当"手握蓝图的质量总监"。
5. **分层审查强度**（[Chico's Tech Blog](https://realtime-ai.chat/posts/coding-agent-review/)）：低风险交 AI+CI、中风险人只审"意图层"、高风险逐行——隐含"人审意图与决策、不审字面代码"的思想。

## 3. 国内产品的相关功能

- **腾讯云 CodeBuddy — Plan Mode**（[官方文档](https://www.codebuddy.cn/docs/ide/Features/Plan-Mode)）：最接近的官方功能。原文："生成方案后，你可以审阅、编辑并确认。这是「执行前可预见」的关键环节——**在代码生成前修正方向，避免后期重构**"；执行中可暂停调方向。**但重点是执行前的一次性计划审批，不是运行中逐个决策/假设的确认**。
- **Trae / 通义灵码**：横评文章（[博客园](https://www.cnblogs.com/itech/p/19009784)、[CSDN 横评](https://tianqi.csdn.net/69f64cfa0a2f6a37c5a78338.html)）显示均有类似 Plan/Ask/Craft 模式与执行可控性宣传，但同样停留在"计划级确认"，未见"决策卡片/假设显式化"粒度的功能。这是明确的产品空白点。

## 4. 总结：与英文社区的异同

**一致的部分**：①（审不过来、瓶颈从写转到审）和②（agent 乱动/隐式假设）在中文社区讨论密度极高，与英文社区高度一致；③ 多 agent 冲突的讨论也在快速增多，解决思路（worktree、接口契约、角色隔离）与英文圈同构。

**中文社区特有/更突出的痛点**（英文调研未覆盖）：

1. **④ 以"面试/绩效"形态爆发**：中文讨论把"说不清贡献"具体化为"鹅厂面试官问你优势是什么"、大厂把 AI 使用接入绩效考核、"代码暴增 8 倍下守住稳定性"成为新 KPI——痛点载体是**求职与考核焦虑**，路演时对国内评委更有共鸣。
2. **"接手别人 vibe coding 产物"的维护叙事**："你成了自己代码的陌生人"、"AI 隐式假设的状态"互撞——把静默决策的代价量化到了维护成本。
3. **多 agent"AI 官僚主义"**："AI 评审就是智障互相骗"、上下文烧钱——中文社区已经在反思 agent 委员会模式，结论是**关键决策必须回到人**，恰好支撑"决策卡片"类方案的必要性。
4. **意图/推理链丢失被明确点名**（"意图断了"、"diff 里缺失为什么"）——与"假设确认/决策卡片"直接对位，且国内产品（CodeBuddy Plan Mode 等）只做到计划级审批、没做到决策级，可作为差异化论据。

## Sources

[V2EX 1224238](https://www.v2ex.com/t/1224238) · [V2EX 1221653](https://www.v2ex.com/t/1221653) · [V2EX 1112737](https://www.v2ex.com/t/1112737) · [V2EX 1238942](https://www.v2ex.com/t/1238942) · [虎嗅](https://www.huxiu.com/article/4869850.html) · [Chico's Tech Blog](https://realtime-ai.chat/posts/coding-agent-review/) · [掘金](https://juejin.cn/post/7670092136001060907) · [陈广亮博客](https://chenguangliang.com/posts/blog197_vibe-coding-maintenance-real-test/) · [ruanyf/weekly #8254](https://github.com/ruanyf/weekly/issues/8254) · [鹅厂面试官（微信）](https://mp.weixin.qq.com/s/TD4QN-14GGTWdUHK5E9Dxw) · [知乎面试题汇总](https://zhuanlan.zhihu.com/p/2036091840148005434) · [tinyash/gojaja](https://www.tinyash.com/blog/gojaja-multi-agent-coordination-how-to/) · [jsjson worktree 指南](https://www.jsjson.com/blog/parallel-ai-coding-worktree-guide) · [觉醒AI BDD/ADR](https://www.jxxy.net/ai/articles/bdd-adr-prd-decisions-humans-ai/) · [CSDN ADR](https://blog.csdn.net/weixin_63764436/article/details/162753924) · [CSDN Linus 立法](https://blog.csdn.net/csdnnews/article/details/160158710) · [80aj 代码归属](https://www.80aj.com/2026/08/31/ai-code-ownership/) · [CodeBuddy Plan Mode 文档](https://www.codebuddy.cn/docs/ide/Features/Plan-Mode) · [博客园工具对比](https://www.cnblogs.com/itech/p/19009784) · [CSDN 五大工具横评](https://tianqi.csdn.net/69f64cfa0a2f6a37c5a78338.html) · [少数派 101833](https://sspai.com/post/101833) · [知乎问题（403 未抓到正文）](https://www.zhihu.com/question/1965020459205619746)
