调研完成。做了 ~17 次英文检索 + 4 次原文抓取，主要覆盖 GitHub / arXiv / HN·Reddit 二手汇总 / 厂商文档与工程博客。先说结论：你们讨论里最核心的那个东西（标红标蓝 + 上游 prompt 改动 + 人类操作 log = 贡献证明，也就是你们自己说的"大一统理论"）确实没人做成产品，但周边每一块都被做完了，边界比想象中窄很多。下面是完整证据链。

---

一、需求侧：哪些痛点有真实、可引用的反馈

1. 审查瓶颈是被量化过的，不是感觉

- SmartBear 对 Cisco 团队的分析：人类缺陷检出能力的上限是约 400 行，超过之后检出率断崖下跌。而"一个 prompt 吐 600 行"是 agent 的常态 —— 超过 400 行你拿到的不是 review，是 rubber stamp。
- "写代码的成本坍塌了，但读代码的成本没有" —— 一个人带 agent 一天能开 3–10 个 PR，传统"写和审速度相当"的假设已经破产。
- 审批疲劳反例很重要：创业公司加了审批队列、Slack 审批按钮之后，人点"approve"根本不读 —— 审批请求夹在 standup 和日历通知中间，被当成随手点赞处理。这条是失败案例：给人加一个"批准"按钮，等于什么都没做。

2. Agent 不会主动求助 —— 有 benchmark 实锤

HiL-Bench（arXiv 2604.09408，标题直接就叫 Do Agents Know When to Ask for Help?）：

▎ 信息完整时通过率 75–89%；当 agent 需要自己判断"要不要求助"时，通过率崩到 4–24%。
▎ Claude 能检测到自己的不确定，但不会据此行动；GPT 系则直接自信地在错误信念上执行。

最危险的象限被论文命名为 confident failure：agent 从不发问，形成错误信念，交出看似合理的错误产物。这条是你们"求助报告"想法的最强背书。

3. 隐性决策 —— agent 在替你做你没指定的决定

- "每一个 [ASSUMPTION: ...] 标签，都标出一个你没指定、agent 自己填了的地方。" 数据库选型、鉴权模型、业务逻辑放哪 —— 全部被静默决定，你只在代码写完之后才发现哪个错了。
- 具体案例：一个 12 个词的需求里立刻浮出 4 个决策，其中 3 个有真实架构影响。
- 论文原话：开发者在把决策权让渡给 agent，而自己没意识到重要设计决策正在没有自己参与的情况下发生。
- 多 agent 时会复利：第一个 agent 的理解偏移变成第二个的输入，第二个"在错误地基上自信地努力工作"，等浮到人眼前时错误已被多层连贯的工作放大并掩盖。

4. 开发者明确说出了他们想要什么（CHI 2025，微软研究院）

Interactive Debugging and Steering of Multi-Agent AI Systems（arXiv 2503.02068）用户研究结论：开发者想要中断卡住的 agent、重置到更早的点、编辑消息来引导 —— 还主动提出想要 agent 版的"断点"。你们讨论里的直觉和这篇论文的用户诉求几乎逐条对上。

5. 干预的真实分类学（arXiv 2506.12347，Why AI Agents Still Need You）

野外会话中人类干预分六类：纠错、改向、补上下文、验证、精修、补边界情况。论文点名的工具缺口：会话中把约束传达给 agent 的机制不足、agent 推理与决策过程的透明度不足。

6. Context rot —— 术语 2025 年 6 月由一位 HN 评论者提出，Chroma 用 18 个模型（含 GPT-4.1、Claude 4、Gemini 2.5）做了验证。表现：第 40 条消息左右开始忘记一小时前自己写的函数、重新引入已修的 bug、违反早先约定的命名。这是你们"0 上下文会诊"直觉的依据。

---

二、供给侧：已经被做完的部分（重点，决定你们不能做什么）

我按赛题四个方向逐条对照，红灯 = 别碰：

┌──────────────────┬─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┬───────────────────────────────────────────────────────┐
│       方向       │                                                        已有实现                                                         │                         判断                          │
├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ 方向四           │ Cursor Blame（企业版，AI 感知的 git blame）、agentblame（行级 AI 归因，PR 摘要给出 AI/人类行数、diff 里文件级徽章、行级 │ 🔴                                                    │
│ Attribution      │  gutter 标记）、git-ai（开源 git 扩展，归因绑定到 commit，无需 hook）                                                   │ 做完了，而且是行级。再做一个行级归因工具＝重复造轮子  │
├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ 方向二           │ Vibe Kanban（看板 + 并行 agent + 可视化 review）、Conductor（macOS，多 Claude Code/Codex 并行                           │ 🔴 极度拥挤，且两天半做不过成熟品                     │
│ Multi-Agent 编排 │ worktree）、Sculptor（Imbue，Docker 隔离并行）、Claude Squad 等，一整个"Tier 2 编排层"生态                              │                                                       │
├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ 方向一           │ CodeRabbit 专门写过"审查瓶颈是理解意图"、AI Code Review Packet（结构化 PR                                               │ 🟡 事后那一半做完了，事中还空着                       │
│ 让人看得懂       │ 附件：意图/影响面/风险等级/测试/回滚方案/开放问题）、Aviator Verify（真流量验证意图）                                   │                                                       │
├──────────────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┼───────────────────────────────────────────────────────┤
│ 方向三 降门槛    │ Lovable / Bolt / v0 一整条赛道                                                                                          │ 🔴 拥挤                                               │
└──────────────────┴─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┴───────────────────────────────────────────────────────┘

你们讨论里的具体想法，逐个对照：

- "实时可视化窗口" → agents-observe（MIT，624+ star，hook 事件实时流到 web 界面，看得到每个 agent 调什么工具、碰什么文件、子 agent 谱系，0.9.7 加了 token/成本）+ SigNoz / OpenObserve / Arthur 一整套 OTel 方案。🔴 只读观测做完了 —— 但全是只读，看得到管不着，这正是缺口所在。
- "实时插话改方向" → 🔴 Claude Code CLI 原生就有。你打字回车，消息在两次工具调用之间注入 agent loop，不打断执行。（有趣的是桌面版没有，得等本轮结束 —— 有一堆 issue 在催：#71726、#30492、#64624）
- "回到之前的点改一改" → 🔴 Claude Code /rewind（2.1.191，2026-06-25）已经能同时回滚对话和文件，六个选项，每个 user prompt 自动打 checkpoint；LangGraph Studio 能在任意 checkpoint 编辑 state 并 fork 新分支；AGDebugger（微软研究院 CHI 2025 原型）能内联编辑历史消息并重置。
- "异源模型 0 上下文会诊" → 🔴 zen-mcp-server（Claude Code 中途拉 Gemini/GPT/Grok/Ollama 做二次意见、多模型辩论、代码审查）+ senate（多 agent 辩论技能包，parliament/court/consensus，shell 出去调各家 CLI，每轮派 fresh subagent）。
- "卡住时打包求助报告" → 🟡 你自己桌面上的 handoff-skill 已经是这个；OpenAI 正在测 Codex 异步提问（agent 提问后继续做不依赖该答案的部分，答案回来再调整）。
- "人类操作写 log，AI 总结，不操作就是没贡献" → 🟢 没找到任何实现。

---

三、失败与效果不好的尝试（这部分对你们最有用）

1. Vibe Kanban 的母公司 Bloop 于 2026-04-10 宣布关停，项目转社区维护、云端功能下线、订阅退款。多 agent 编排 UI 这条路商业上没跑通。
2. 审批队列 / Slack 审批按钮 → 制造了 rubber stamp，比不做还糟。任何"给人加一个 Approve 按钮"的设计都要直接毙掉。
3. 多模型辩论成本高，senate 项目自己在 README 里承认"强单 agent prompting 在部分 benchmark 上能打平"，并引用了 Wang et al. 2024《辩论何时值得这个成本》。别把"叫更多模型来投票"当卖点。
4. reset / fork 的硬伤：AGDebugger 自陈两条 —— 回滚丢弃下游所有工作；外部副作用不可回滚（agent 已经把邮件发出去了就收不回来）。你们讨论里"改上游但不影响之前步骤、只影响后续"的直觉，恰恰是绕开这个硬伤的思路，但没人实现。
5. 只读 dashboard 的天花板：观测生态很成熟，但没有一个能让你在看到问题的当下直接介入。看得越清楚，管不着的挫败感越强。

---

四、真正的空白：运行中的「决策层」没有人做

把上面拼起来会看到一个非常清晰的结构性空洞：

事前  ── spec-kit / Kiro：/clarify 逼你把歧义答清楚        ✅ 有人做
运行中 ── 只读观测（agents-observe / OTel）                 ✅ 有人做（但只读）
运行中 ── ★ agent 正在替你做的决定，实时浮出来、可翻案 ★    ❌ 没人做
事后  ── review packet / CodeRabbit：总结意图              ✅ 有人做
事后  ── 行级归因（Cursor Blame / agentblame / git-ai）    ✅ 有人做

中间那一格是空的。而且它被验证过是刚需但只停留在 prompting 技巧层面：有人写博客教你让 agent 输出 [ASSUMPTION: ...] 标签，说明痛点真实到有人自己想土办法 —— 但没有任何产品把它做成运行中的、可翻案的决策流。这是黑客松最理想的位置：需求已验证，实现还空着。

主推方案：决策流（Decision Stream）—— 人只审决定，不审 diff

一句话：agent 干活的时候，每做一个"你没指定、我自己定了"的决定，就实时吐一张卡片；人只看这些卡片，可以当场翻案；翻案只影响后续步骤，不回滚已完成的工作；所有翻案自动构成"这个人干了什么"的记录。

三个机制，正好把你们讨论里散着的三个点缝成一个（就是你们说的"大一统理论"）：

① 决策卡片 = 你们说的"标红标蓝"
不靠模型自觉。用 harness hook 在固定卡点（写文件前 / 跑命令前 / 计划变更时）强制抽取："我准备做 X，因为 Y，你没指定的部分我选了 Z，最可能错在 W。"
- 🔵 蓝 = agent 自由发挥（你没说，我定了）
- 🔴 红 = 与既有计划/约定冲突
- 灰 = 纯执行，不用看
  产品价值：把 600 行 diff 压成 5 张卡片，直接绕开 400 行审查天花板。这不是"翻译改动"（那是方向一的例子，也是 review packet 做过的事），而是在改动发生之前就把决策点截出来。

② 翻案只向前生效 = 你们说的"上游 prompt 改动"
人点"这里不对，应该用 X" → 这条约束以 mid-conversation system message 的形式注入（这个技术路径是成立的，有工程博客验证：前缀不变、缓存不破、从该点起作为系统指令生效），只约束后续步骤，不回滚已完成的工作。
这正好避开 AGDebugger 自陈的两个硬伤（丢下游工作、外部副作用不可撤销）。这是你们相对所有已有实现的真正差异点，我建议路演时把这一条当作核心卖点讲。

③ 翻案日志 = attribution，但不是行级
现有的 Cursor Blame / agentblame / git-ai 全在回答"这行谁写的"。没人回答"这个人做了哪些判断"。 你们的"不操作就是没贡献"正是另一个答案：归因人的干预，不归因人的敲键。 会话结束自动生成："他放过了 23 个决定，翻案了 5 个，其中 2 次把跑偏的方向拧了回来。"

为什么这个方案在产品上成立

- 对上赛题边界："把人从作品里拿掉，它就不该还能正常工作" —— 决策流没人看就是死的，天然满足。
- 非技术同学真能上手：卡片是中文的判断题，不是代码。顺手吃掉方向三，而且是比"用中文描述界面"更硬的解法。
- 两分钟路演讲得清：左边 agent 在跑，右边卡片一张张冒出来，你点一张、改一句、agent 后续行为立刻变、之前的活没白干，最后弹出一份贡献报告。演示动线是自解释的。
- 两天半做得完：核心是 hook 拦截 + 一个卡片流 UI + 一条 system message 注入通道。可以先只支持 Claude Code（你们自己也说了"不用跨 harness，做 demo 展示理念就行"）。

必须提醒的三个风险

1. 让 agent 自报假设不可靠 —— HiL-Bench 已经证明"Claude 检测得到不确定但不行动"。所以不能靠 prompt 请它自觉，必须在 harness 层强制卡点抽取。这一点做不好，整个 demo 会退化成"agent 偶尔说几句废话"。
2. 判断"自由发挥"需要 baseline —— 得先有一份 plan/spec 做对照，否则无法区分蓝色和灰色。建议 demo 流程强制从 plan mode 起步。
3. 决策卡片会太多 —— 一旦每个动作都弹卡，就变成新的审批疲劳（第三节的失败案例）。必须有分级和静默阈值，宁可漏也不要刷屏。这是产品成败点，不是工程细节。

两个备选（我不推荐，但列出理由）

- 自动求助包 + 0 上下文异源会诊：会诊部分被 zen-mcp 和 senate 占了，你自己的 handoff-skill 也做了一半；剩下的差异化只有"自动检测卡住 + 脱敏打包"。且卡住这件事没法在路演现场稳定复现，demo 风险高。
- 可编辑时间块工作流图：AGDebugger + LangGraph Studio 已经覆盖了编辑与 fork，你们的增量只剩"前向生效"这一点 —— 而这一点在主推方案里作为机制②已经吃到了，不必为它单独做一整套流程图 UI，两天半来不及。

一条产品判断

出题方知是（CheeseX）自己的宣传语是"过程一边干一边沉淀成文档，做完之后这个过程本身就是你的作品集"。做纯 attribution / 作品集会和出题方现有产品正面撞车。 把 attribution 降级成决策流的副产物（机制③）是更聪明的位置：既回应了方向四，又不在人家主场跟人家比。

---

调研范围说明：WebSearch 仅限美国节点，所以国内社区（掘金、V2EX、即刻）没有系统覆盖，以上结论基于英文源。另外 ACM DL 正文 403，AGDebugger 的细节取自 arXiv 版和作者主页的二手描述，如果要引用进路演材料建议再核一遍原文。

Sources:
- HiL-Bench: Do Agents Know When to Ask for Help? (https://arxiv.org/pdf/2604.09408)
- Why AI Agents Still Need You: Developer-Agent Collaborations in the Wild (https://arxiv.org/pdf/2506.12347)
- Interactive Debugging and Steering of Multi-Agent AI Systems (AGDebugger, CHI 2025) (https://arxiv.org/abs/2503.02068)
- AI Broke Your Code Review — 400-line threshold (https://bryanfinster.substack.com/p/ai-broke-your-code-review-heres-how)
- AI Agent Approval Fatigue Is Quietly Undermining Startup Safety (https://startupfortune.com/ai-agent-approval-fatigue-is-quietly-undermining-startup-safety/)
- How to Stop Letting AI Agents Guess Your Requirements（ASSUMPTION 标签） (https://www.freecodecamp.org/news/how-to-stop-letting-ai-agents-guess-your-requirements/)
- Context Rot: Why Claude Code Sessions Decay (https://towardsdatascience.com/governed-context-managing-context-rot-in-claude-code/)
- agents-observe（只读观测） (https://github.com/simple10/agents-observe)
- Vibe Kanban (https://vibekanban.com/) ／ 9 Open-Source Agent Orchestrators (2026) (https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- zen-mcp-server (https://github.com/HomecareHomebase/zen-mcp-server) ／ senate（多 agent 辩论） (https://github.com/SebastianElvis/senate)
- agentblame (https://github.com/mesa-dot-dev/agentblame) ／ git-ai (https://github.com/git-ai-project/git-ai) ／ Cursor Blame (https://cursor.com/docs/integrations/cursor-blame)
- Claude Code Checkpointing / rewind (https://code.claude.com/docs/en/checkpointing) ／ Real-time steering issue #64624 (https://github.com/anthropics/claude-code/issues/64624)
- Mid-Conversation System Messages（前向注入不破缓存） (https://dev.to/pavelespitia/mid-conversation-system-prompts-steering-an-agent-without-breaking-the-cache-2kd3)
- AI Code Review Packet (https://dev.to/jackm-singularity/ai-code-review-packet-make-agent-written-pull-requests-easy-to-trust-2c0g) ／ CodeRabbit: 审查瓶颈是理解意图 (https://www.coderabbit.ai/blog/bottleneck-in-code-review-is-understanding-intent)
- GitHub Spec Kit (https://github.com/github/spec-kit) ／ Codex 异步提问 (https://thenewstack.io/codex-async-developer-messaging/)

要我把这份调研整理成可分享的网页版（方便发给队友）吗？一句话就行。