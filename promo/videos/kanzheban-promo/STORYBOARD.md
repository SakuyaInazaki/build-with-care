---
format: 1920x1080
duration: 91s
message: "你确认过的那几条要求，在 Agent 每一步之前都被对照一次"
arc: BAB — 旧做法(事后读 diff) → 新做法预告 → 产品 → 要求被记下 → 它开始干活 → 每一步被对照 → 拦停 → 你的四个动作 → 绿只由证据产生 → 真实产物 → 人的判断留下来 → 品牌
audience: 黑客松评委；用 agent 写代码的学生团队；非技术验收人（产品/老师/助教）
mode: collaborative
music: none
---

> 全片无旁白、无 BGM（用户选择先出无声版）。信息由**中文字卡**与**真实 UI 文字**承担。
> 每帧的 `titles:` 是该帧屏幕上出现的字卡原文，`voiceover:` 一律为空。
> 所有数字均来自真实完成的任务「帮我构建一个网页版超级马里奥」的 `state.json`，
> 见文末「数字出处」。不得改写、四舍五入或补齐未发生的项。

## Video direction

写一次，全片继承；每帧的 Scene 行只写增量。

### 工艺依据

两类来源，分开标明：

- **调研文档**（`docs/苹果产品与软件宣传片风格调研.md`）——§4 八条方法、§5 镜头词汇表、§6 版式起点、§10 验收表。
- **本轮第一手观察**——2026-09-06 在浏览器中对《iOS 26: Introducing Liquid Glass》(4:33) 取样
  0:00 / 0:38 / 1:38 / 2:38 / 3:44 / 4:28 六个画面。以下标 `[观察]` 的条目来自这六帧，
  标 `[推论]` 的是我从这六帧归纳的规则，不是苹果的公开规范。取样是离散画面，
  不足以推算镜头长度、缓动曲线或 BPM——本片的时长与节拍是本项目的选择。

### 六条构图规则

1. **溢出画框，不要悬浮居中。** `[观察]` 该片每个 UI 平面都被画框至少一边裁掉：
   标题帧玻璃体溢出上/右缘，2:38 内容面溢出两边，3:44 屏幕墙四边全溢。
   `[推论]` 本片任何产品截图都必须至少一边切出画外；禁止"四周留白的居中卡片"。
2. **倾斜的许可条件是"这一面上的字不需要被读"。** `[观察]` 2:38 那面内容平面倾斜约 40°，
   平面上的正文完全无法阅读——它是质感；要读的是浮在它上面的控件。
   `[推论]` 本片只在**卡片正文降级为质感**的窗口倾斜（F5 的单元条、F9 的绿卡阵列）。
   任何要求观众读中文句子、读 UI 文案、读数字的窗口，机位必须正面且静止。
   这与调研文档 §5 把"需要阅读的 UI 长时间大角度倾斜"列为误用一致。
3. **说"多"用平铺许多正面实例，不是把一个缩小。** `[观察]` 3:44 是一整墙正面屏幕平铺四边溢出。
   `[推论]` F2 的 28 个单元、F9 的 18 张绿卡都用平铺，不用缩放。
4. **说"成体系"用互相叠压且共享同一内容的平面。** `[观察]` 4:28 三台设备前后叠压、全部正面、
   跑同一张壁纸、近白底几乎无影。`[推论]` F12 用同样的叠压关系收尾。
5. **讲一个控件的行为用微距 + 浅景深。** `[观察]` 1:38 极特写手持机身，背景虚化，被解释的菜单接近正面。
   `[推论]` F7 的红卡用这个姿态：推到卡片本身，其余栏推虚。
6. **标题左对齐、分行堆叠、居上三分之一。** `[观察]` 0:00 "Introducing / Liquid / Glass" 三行左对齐在左上。
   `[推论]` 本片所有中文字卡左对齐分行，不居中；中文按语义块断行，不逐词闪现（调研文档 §4.5）。

### 分层：只用一次，在该用的地方

不做成全片骨架。**只在 F4→F6 这一段**出现一次可见的层关系：
「你的要求」是底面，「Agent 的行动」叠在它上面，两者同框。这是产品机制本身的形状，
不是装饰。其余帧不堆层。

### 调色（取自 `frame.md`，不发明）

- 底：`bg-primary` 纸色；墨：`text-primary`；次级：`text-secondary`；细线：`line` 是唯一结构装置。
- 暖点 `accent` 极少量，只标记当前焦点，**永不承担 UI 语义**。
- 红/蓝/绿**只在真实产品截图内部出现**，保持产品原意
  （`ui-red` 约束冲突 / `ui-blue` Agent 自主决定 / `ui-green` 受控检查通过）。帧层不得借用。

### 动效语法与揭示模型

- 长尾缓出，`power3` 默认；**不弹跳**。
- 无旁白，揭示节拍跟**中文字卡的阅读节奏**走：一句字卡 ≈ 一个 Scene 窗口。
  t=0 只出现此刻在读的那一句，其余等自己的拍子；绝不在前 25% 倒完整屏。
- 停住时宁可完全静止：不做循环呼吸，不做后半段慢推慢摇；唯一许可的存活感是低幅 jitter。
- 中文字卡停留：短语 ≥1.2s，含新术语或数字的句子 ≥1.8s（调研文档 §6：新术语、长中文句子与数字应留更久）。

### 静止帧分配

- **F7 是全片唯一的完全静止帧**——2 秒零位移，机位正面。这是"人还来得及说不"的那一秒。
- F10 结果出现后停住读 1.5 秒。F12 整帧静止。其余帧按字卡节拍逐层揭示。

### 安全边距

四周各留 5%（96px），内容规划进上方 83%（下方 ~17% 为字幕带保留，即使本片无字幕也保持）。

### 音乐落点（无声版不含音频，供后期对齐）

每帧 `music_cue:` 标出该帧的音乐事件。总则：音乐建立章节，声音标记落点；
F7 拦停处**整段留白**，F11 数字落定处一次落定和弦。完整卡点表见 `MUSIC-CUES.md`。

### 负面清单

- 浏览器 chrome、地址栏、滚动条、真实鼠标指针、导航栏、页脚。
- 紫蓝色"AI 感"渐变、漂浮 bokeh、粒子屏保、发光边框。
- 帧层使用红/蓝/绿——那是产品的语义，借去做装饰就是撒谎。
- 四周留白的居中卡片（违反规则 1）。
- 任何斜视角状态下要求观众读中文（违反规则 2）。
- 幻灯片式（前 25% 倒完然后冻住）与屏保式（每个元素各自漂浮）两种动效失败。
- fork / branch / 回滚 / 已接入真实异源模型 / dsh 已接入运行时的任何暗示。
- 重复同一张截图来伪造"很多"（规则 3 的平铺必须是真实存在的多个实例）。

---

## Frame 1 — 你说了一句话

- scene: 纸底，单行中文字卡逐拍替换关键词，无产品
- voiceover: ""
- titles: "你说了一句话。" → "它改了一整个文件。" → "中间那些决定，你一个都没看见。"
- duration: 8s
- transition_in: cut
- status: built
- src: compositions/frames/f01-one-sentence.html
- type: hook
- persuasion: Pain validation
- beat: 不安 + 被架空感
- asset_candidates:
- blueprint: kinetic-type-beats (Reproduce)
- focal: —（纯字卡，无素材）
- roles: —
- music_cue: 0.0s 单音钢琴起句；每句字卡落位各一个轻音
- sfx: —

Scene 1 (0.0–2.6s): 纸底空场。第一句「你说了一句话。」左对齐落在**左上三分之一**，占宽约 52%，
per-word staggered reveal（`dynamic-content-sequencing`），长尾落定。右侧留空——不填。机位正面静止。
Scene 2 (2.6–5.2s): 第二句「它改了一整个文件。」在第一句正下方落位；第一句同拍降为 `text-secondary`。
两句之间是硬切换拍，不是淡入（`discrete-text-sequence`）。
Scene 3 (5.2–8.0s): 第三句「中间那些决定，你一个都没看见。」落位，前两句继续降级至最淡。
落定后**完全静止**读满 1.8s（含新概念，按字卡停留规则）。


narrativeRole: 用观众自己的语言把痛说出来，不提产品、不提功能。三句是同一句话的三次推进，
关键词在原位替换（"你说" → "它写" → "你没看见"），替换本身就是这一帧的动作。
keyMessage: 落差不在代码质量，在于决定发生的时候你不在。
note: 用户 2026-09-06 定稿把第二句从"它写了六百行"改为"它改了一整个文件"——
后者不引用任何未经本产品测量的数字，纯字卡与带 UI 的画面因此不存在口径冲突。

## Frame 2 — 四种状态

- scene: 真实过程时间线作底，三组真实数字依次 count-up
- voiceover: ""
- titles: "一次任务。" / "28 个工作单元　111 步" / "其中 17 个决定，是它自己拿的主意。"
- duration: 9s
- transition_in: crossfade
- status: built
- src: compositions/frames/f02-four-states.html
- type: pain_point
- persuasion: Statistical proof（把"看不过来"量化成真实数字）
- beat: 压迫感 → 清醒
- asset_candidates: assets/05-timeline.png — 真实过程时间线，任务记录 + 单元 1–4 横向排列
- blueprint: dataviz-countup (Adapt)
- focal: assets/05-timeline.png
- roles: 05-timeline = background（真实单元条带，横向铺满并**溢出左右两边**，压暗至约 45%）
- music_cue: 2.0s 低频脉冲进入，每个数字落定各一次轻击；7.0s 脉冲不停，接 F3
- sfx: impact-soft ×3

Adapt: 保留 count-up 签名动作；把"图表"换成真实的单元条带，把"多"用**平铺真实实例**表达（构图规则 3），
不缩放、不复制。
Scene 1 (0.0–1.8s): 真实单元条带横向铺满画面下半，左右两边切出画外；条带以恒速向左缓移
（`nudge-curve`，慢-快-慢），卡片正文此刻是质感不是读物。左上落「一次任务。」
Scene 2 (1.8–4.2s): 条带继续移动；「28 个工作单元」与「111 步」两个数字在左上依次 count-up
（`counting-dynamic-scale`），数字用 `tabular-nums` 防跳字。
Scene 3 (4.2–7.0s): 条带**停住**；第三句「其中 17 个决定，是它自己拿的主意。」落位，
17 这个数字 count-up 后停住。机位正面，读满 1.8s。


narrativeRole: 把 F1 的抽象痛换成本产品记录下来的真实数量级。数字来自一次真实任务，不是估算。
keyMessage: 问题不是它干得少，是它替你拿主意的次数你数不过来。

## Frame 3 — 看着办

- scene: 真实纸墨欢迎页：粒子从散布汇聚成 D，落定为 DELEGATE / 交给它办
- voiceover: ""
- titles: "看着办" / "Agent 办事，人看得见，也能介入。"
- duration: 7s
- transition_in: zoom-through
- status: built
- src: compositions/frames/f03-brand.html
- type: product_intro
- persuasion: Friction reduction（不是"你要更努力地审"，是"换个看的位置"）
- beat: 松一口气
- asset_candidates: assets/08-welcome-start.png — Build ／ with Care 起点；assets/09-welcome-1.png — 粒子离散中途；assets/09-welcome-2.png — 向 D 汇聚；assets/09-welcome-3.png — D 成形 + DELEGATE 交给它办
- blueprint: logo-assemble-lockup (Reproduce)
- focal: assets/09-welcome-3.png
- roles: 08-welcome-start = supporting（起点）· 09-welcome-1 / 09-welcome-2 = supporting（汇聚中途）· 09-welcome-3 = cutout（D 成形）
- music_cue: 0.0s 脉冲收束；3.6s D 成形处一次和弦落定；4.5s 只剩钢琴单音
- sfx: riser（0.6–3.4s）

Scene 1 (0.0–1.4s): 起点画面——「Build」与「with Care」分置画面两侧，墨点散布。
镜头正面静止，让观众先认出这是同一张纸。
Scene 2 (1.4–3.6s): 墨点向中心汇聚（真实素材序列的 scale-swap 递进，`scale-swap-transition`），
两侧的英文同拍淡出——它们变成了那个字。
Scene 3 (3.6–6.0s): D 成形并**停住**；下方「DELEGATE　交给它办」与产品名「看着办」落位。
一句定位「Agent 办事，人看得见，也能介入。」在其下落位。完全静止读满 1.6s。


narrativeRole: 产品第一次出现，用它自己的品牌动作出现——散开的墨点汇聚成一个字，
正好是全片主张的形状：散落的判断被收拢成一件可看的东西。
keyMessage: 产品名与一句话定位，此外不加任何形容词。

## Frame 4 — 你说清楚的，被记下来

- scene: 决策看板顶部「已确认要求 v3 · 13 条」展开，13 条要求逐条落位
- voiceover: ""
- titles: "先把你要什么，说清楚一次。" / "已确认要求　v3　13 条"
- duration: 12s
- transition_in: blur-crossfade
- status: built
- src: compositions/frames/f04-stack.html
- type: feature_showcase
- persuasion: Show-don't-tell proof
- beat: 掌控感
- asset_candidates: assets/02-board.png — 决策看板四栏全景；assets/03-constraints-open.png — 要求展开，13 条逐条列出
- blueprint: device-surface-showcase (Adapt)
- focal: assets/03-constraints-open.png
- roles: 02-board = supporting（先建立这是哪儿）· 03-constraints-open = cutout（要求逐条）
- music_cue: 1.5s 钢琴动机第二次出现（与 F1 同一动机，标记"这是同一件事"）
- sfx: —

Adapt: 保留"在真实界面里完成一次核心动作"的结构；把"设备"换成工作台本身。
**本帧是阅读帧**——全程正面、无倾斜（构图规则 2）。
Scene 1 (0.0–2.4s): 决策看板全景铺满画面，**右侧与下缘切出画外**（构图规则 1）；
镜头正面静止，只让观众看清四栏的颜色分布，不读卡片正文。左上落「先把你要什么，说清楚一次。」
Scene 2 (2.4–5.0s): 相机推近到看板上缘的要求条（`coordinate-target-zoom`，正面推进不带旋转），
其余区域推虚（`depth-of-field-blur`）。「已确认要求　v3　13 条」在推进落定时读清。
Scene 3 (5.0–9.0s): 要求条展开，13 条要求自上而下逐条落位（`waterfall-entry`，整组 stagger ≤0.5s）。
落定后静止读满 2.0s。这一屏是全片唯一一次让观众看清"你说过的话"的全文。


narrativeRole: **贯穿对象在这一帧诞生**。它有名字（已确认要求）、有版本号（v3）、有条数（13 条）、
有固定位置（画面上缘）。后面每一次它出现，都必须是同一个对象——同一名字、同一版本、同一位置带入。
keyMessage: 你说的话不是聊天记录，是有版本的约束。
handoff_out: "requirement-rail — 要求条位于 x:640 y:196（1920×1080 坐标），scale 1.0，opacity 1，静止"

## Frame 5 — 然后它开始干活

- scene: 真实过程时间线横向平移，单元 1 → 2 → 3 → 4 依次划过，越走越快
- voiceover: ""
- titles: "然后它开始干活。" / "一个单元，一个单元。"
- duration: 7s
- transition_in: crossfade
- status: built
- src: compositions/frames/f05-it-works.html
- type: feature_showcase
- persuasion: Negative contrast（速度越快，越衬出下一帧那次"停"）
- beat: 加速 → 紧张
- asset_candidates: assets/05-timeline.png — 单元 1「建立单文件游戏的骨架」/ 单元 2「加入 1-1 关卡数据模块」/ 单元 3「实现玩家控制与平台物理」/ 单元 4「像素精灵生成管道」
- blueprint: transcript-scroll-artifact-reveal (Adapt)
- focal: assets/05-timeline.png
- roles: 05-timeline = cutout（单元条带）
- music_cue: 0.0s 脉冲加密，节奏推进；6.5s 骤停（为 F7 的留白铺垫）
- sfx: whoosh-soft（一次，不逐条叠）

Adapt: 保留"沿一条长内容纵向/横向行进读证据"的结构；本片是横向。
**本帧是唯一被许可倾斜的叙事帧**——单元卡正文在此降级为质感，观众只需看见"一条接一条"。
Scene 1 (0.0–1.6s): 承接 F4，画面仍正面；左上落「然后它开始干活。」
Scene 2 (1.6–4.6s): 平面向后倾（rotateX 约 16°、rotateY 约 −12°，`3d-camera-flight`），
单元条带沿透视向左行进并加速，卡片正文此刻不可读、也不需要读。
条带在两侧持续切出画外。第二句「一个单元，一个单元。」落在左上，**保持正面不随平面倾斜**。
Scene 3 (4.6–7.0s): 行进减速；平面 tilt-to-flatten 回正到 0°，停住。
回正本身就是下一帧"要开始读了"的信号。


narrativeRole: 建立"它推进得很快"的体感，为 F7 的静止蓄力。这一帧不解释机制，只给速度。
keyMessage: 它不等你。所以对照必须自动发生。

## Frame 6 — 每一步落笔之前，先对一次

- scene: 卡片双栏详情推近：左「你的要求 v3」三条依次亮起，右「Agent 的行动」浮现
- voiceover: ""
- titles: "每一步落笔之前，它先和你说过的话对一次。" / 左栏眉标"你的要求" / 右栏眉标"Agent 的行动"
- duration: 11s
- transition_in: crossfade
- status: built
- src: compositions/frames/f06-reconcile.html
- type: feature_showcase
- persuasion: Show-don't-tell proof（对照关系本身就是论据）
- beat: 清楚
- asset_candidates: assets/04-card-detail.png — 双栏详情：左「你的要求 v3」三条、右「Agent 的行动」+ 影响 + 审查依据
- blueprint: comparison-split (Adapt)
- focal: assets/04-card-detail.png
- roles: 04-card-detail = cutout（双栏详情）
- music_cue: 0.0s 只剩钢琴；4.0s 左栏亮起处一个轻音；8.0s 右栏落位一个轻音
- sfx: —

Adapt: 保留"两个等重项目并置"的结构与并置本身的签名；去掉 book-open 的镜像 3D 倾斜——
**本帧是全片信息密度最高的阅读帧，必须正面静止**（构图规则 2）。
这是全片唯一出现可见层关系的一段：左栏是底面，右栏叠在它上面，同框可比。
Scene 1 (0.0–2.4s): 卡片详情正面铺满，**左右两侧切出画外**；标题行「决定与证据」与那条长决策文本落位。
Scene 2 (2.4–5.6s): 左栏「你的要求」眉标与版本徽标 v3 亮起（`asr-keyword-glow` 的低幅档，
`accent` 只描边不填色）；三条要求自上而下逐条亮起。
Scene 3 (5.6–8.8s): 右栏「Agent 的行动」整段浮起并落位（沿 Z 轴自左栏上方 8px 落下，
让"叠在上面"这层关系可见）；「影响」小字随后落位。
Scene 4 (8.8–11.0s): 两栏都亮；左上落「每一步落笔之前，它先和你说过的话对一次。」
完全静止读满 2.2s。


narrativeRole: 全片核心镜头，也是**贯穿对象的复现**。F4 里那条要求带着同一个版本号 v3 回到画面，
只是这次它旁边多了一列——Agent 实际要做的事。相机在此稳定，不做推拉，让两栏都可读。
keyMessage: 不是事后翻译 diff，是事前对照约束。
handoff_in: "requirement-rail — 从 F4 的 x:640 y:196 平移至左栏 x:508 y:604，scale 0.78，opacity 1，减速落位"

## Frame 7 — 对不上，就停在这里

- scene: 红卡「约束冲突 / 已拦停」，全片唯一一次画面完全静止
- voiceover: ""
- titles: "对不上，就停在这里。" / "11 次闸口，8 次被拦在写文件之前。"
- duration: 7s
- transition_in: crossfade
- status: built
- src: compositions/frames/f07-blocked.html
- type: feature_showcase
- persuasion: Risk reversal（把人拿掉，这条流程走不下去）
- beat: 停顿 + 安心
- asset_candidates: assets/04-card-detail.png — 红卡「冲突处理记录」「已拦停」「begin_unit 已拦停」
- blueprint: kinetic-type-beats (Adapt)
- focal: assets/04-card-detail.png
- roles: 04-card-detail = cutout（红卡与"已拦停"）
- music_cue: **0.0s 起整段留白，无音乐、无音效，直到 7.0s**——全片唯一一次静音
- sfx: —

Adapt: 借"一句话独占一屏"的结构；signature 保留在**停止本身**上。
采用构图规则 5 的姿态：微距推到红卡，其余栏推虚。
Scene 1 (0.0–2.0s): 从 F6 的双栏切到红卡本身——卡片占画面约 60%，上缘与右缘切出画外；
相邻栏推虚（`depth-of-field-blur`）。卡上「约束冲突」「已拦停」「begin_unit 已拦停」保持可读。
Scene 2 (2.0–3.4s): 左上落「对不上，就停在这里。」
Scene 3 (3.4–5.4s): **完全静止 2.0 秒。零位移、零缩放、零透明度变化、无 jitter。**
这 2 秒是全片的论点：把人拿掉，这条流程就走不下去。
Scene 4 (5.4–7.0s): 第二句「11 次闸口，8 次被拦在写文件之前。」落在第一句下方，静止读满。


narrativeRole: 全片的静止点。前 6 帧都在动，这一帧停 2 秒不动——这就是"人还来得及说不"的那一秒。
音乐（后期加入时）在这里留白一次。
keyMessage: 拦是在写文件之前拦的，不是写完之后报告。
honesty: 只说"拦在写文件之前"，不说"回滚"——首版不回滚磁盘文件。

## Frame 8 — 停下来之后，你有四个动作

- scene: 纸底纯排版，四个动作名逐条落位，右侧挂真实使用次数
- voiceover: ""
- titles: "按原要求改正　6 次" / "改成另一种做法　2 次" / "仅本次允许　2 次" / "停止任务" / "这一次任务里，你用了 10 次。"
- duration: 8s
- transition_in: crossfade
- status: built
- src: compositions/frames/f08-four-actions.html
- type: feature_showcase
- persuasion: Value stacking（四档裁决，不是一个"同意/拒绝"）
- beat: 掌控感
- asset_candidates:
- blueprint: grid-card-assemble (Adapt)
- focal: —（纸底排版，产品原文）
- roles: —
- music_cue: 0.5s 音乐回来，单音钢琴；每个动作落位一个轻音（四次）
- sfx: —

Adapt: 保留"逐条累积成列"的结构；载体从卡片网格换成纸底排版行。
**本帧刻意不做成 UI 截图**：这次任务结束时没有待处理红卡，截不到四个按钮同时可点的真实状态，
伪造一张就是造假。用产品原文 + 真实统计代替。
Scene 1 (0.0–1.6s): 纸底空场；左上落「停下来之后，你有四个动作。」
Scene 2 (1.6–5.6s): 四行自上而下逐条落位（`waterfall-entry`，每行一拍），
每行左侧是产品里的原文动作名，右侧对齐真实次数：
「按原要求改正　6 次」「改成另一种做法　2 次」「仅本次允许　2 次」「停止任务」。
第四行**不带次数**——这次没用到，不补一个不存在的数字。行与行之间是 `line` 细线。
Scene 3 (5.6–8.0s): 底部一行「这一次任务里，你用了 10 次。」落位；10 count-up。静止读满 1.8s。


narrativeRole: 四个动作名是产品里的原文（Board.tsx 的按钮文案），次数是这次任务的真实统计。
本帧刻意**不做成假的 UI 截图**——本次任务结束时没有待处理的红卡，截不到四个按钮同时可点的真实状态，
因此用纸底排版呈现产品原文，不伪造界面。
keyMessage: 你不是只能点"同意"。
honesty: 「停止任务」这一次没被用到，所以它不带次数。不补一个不存在的数字。

## Frame 9 — 绿色只由证据产生

- scene: 已验证栏展开的绿卡阵列 → 推近到三条验证证据 ✓
- voiceover: ""
- titles: "绿色不是它说没问题。" / "是受控检查过了。" / "HTML 基本结构 ✓　内联 JavaScript 语法 ✓　无外部页面资源 ✓"
- duration: 7s
- transition_in: zoom-through
- status: built
- src: compositions/frames/f09-evidence.html
- type: benefit_highlight
- persuasion: Show-don't-tell proof
- beat: 信任
- asset_candidates: assets/03b-verified-open.png — 已验证栏展开，绿卡成列；assets/06-artifacts.png — 验证证据三条 ✓
- blueprint: grid-card-assemble (Reproduce)
- focal: assets/03b-verified-open.png
- roles: 03b-verified-open = cutout（绿卡阵列）· 06-artifacts = supporting（验证证据三条）
- music_cue: 0.0s 脉冲回来但更轻；5.0s 三条 ✓ 落位处三个短音
- sfx: —

Scene 1 (0.0–2.2s): 已验证栏展开，绿卡**平铺成列并四边溢出画框**（构图规则 3——用真实的 18 张，
不复制、不缩放）。此窗口平面可带轻微后倾（rotateX ≤10°），因为卡片正文此刻是质感。
左上落「绿色不是它说没问题。」
Scene 2 (2.2–4.4s): 平面 tilt-to-flatten 回正；第二句「是受控检查过了。」落位。
Scene 3 (4.4–7.0s): 切到验证证据清单，正面静止；三条「HTML 基本结构 ✓ / 内联 JavaScript 语法 ✓ /
无外部页面资源 ✓」逐条落位并各自打勾（`svg-path-draw` 画勾）。静止读满 1.6s。


narrativeRole: 回答"你怎么知道它真做对了"。绿是执行器绑定的证据，人工认可不能把卡变绿。
keyMessage: 通过与否，由受控检查说了算。

## Frame 10 — 它交出来的东西

- scene: 从验证证据拉开，露出真实产物在跑（WORLD 1-1）
- voiceover: ""
- titles: "这是它交出来的东西。"
- duration: 7s
- transition_in: crossfade
- status: built
- src: compositions/frames/f10-artifact.html
- type: benefit_highlight
- persuasion: Show-don't-tell proof
- beat: 踏实
- asset_candidates: assets/06-artifacts.png — 成果与验证：内嵌可运行的 WORLD 1-1 + 三条验证证据
- blueprint: zoom-out-workspace-reveal (Reproduce)
- focal: assets/06-artifacts.png
- roles: 06-artifacts = cutout（内嵌产物 + 验证证据）
- music_cue: 0.0s 钢琴回到 F1 的动机；4.5s 产物出现处一次抬升
- sfx: —

Scene 1 (0.0–2.0s): 紧接 F9，画面仍停在验证证据的特写上（这是"神秘的局部"）。
Scene 2 (2.0–4.5s): **一次连续减速的拉远**（`multi-phase-camera` 的 pull-back 段，全程正面无旋转），
露出这三条证据挂在谁身上——右侧是真实产物预览，WORLD 1-1 在跑。左缘切出画外。
Scene 3 (4.5–7.0s): 落定；左上落「这是它交出来的东西。」
**完全静止 1.5s**，让产物自己被看清。此处不加任何新信息（调研文档 §10：结果有停留，结尾不再增加新信息）。


narrativeRole: 全局结果收束。结果要停住让人看清，不在这里加新信息。
keyMessage: 过程可对账，产物是真的。

## Frame 11 — 留下来的是你的判断

- scene: 我的判断报告，10 与 8 两个数字 count-up 落定
- voiceover: ""
- titles: "这次任务，你留下了 10 次判断，其中 8 次纠正了做法。" / "一年以后，你能证明的不是哪行代码是你写的。"
- duration: 9s
- transition_in: crossfade
- status: built
- src: compositions/frames/f11-your-judgement.html
- type: benefit_highlight
- persuasion: Future pacing（赛题第二层：一年之后他自己也变强了）
- beat: 被看见
- asset_candidates: assets/07-record.png — 我的判断：「这次任务，你留下了 10 次判断，其中 8 次纠正了做法。」+ 判断条目
- blueprint: dataviz-countup (Reproduce)
- focal: assets/07-record.png
- roles: 07-record = cutout（我的判断报告）
- music_cue: 3.5s 两个数字落定处**一次落定和弦**（全片最强重音，只此一次）；6.0s 起只剩余韵
- sfx: —

Scene 1 (0.0–2.0s): 「我的判断」页正面铺满，右侧「留给下次的自己」侧栏切出画外。
镜头正面静止——本帧全程不动。
Scene 2 (2.0–4.2s): 报告首句在页面上逐块落位：「这次任务，你留下了 __ 次判断，
其中 __ 次纠正了做法。」两个数字 count-up 至 10 与 8（`counting-dynamic-scale`），
数字用产品自己的强调色，其余为墨色。
Scene 3 (4.2–6.4s): 下方真实判断条目「按原要求改正 · 已产生后续改动 · 要求 v1」逐条淡入至半透明——
它们是背景，不要求阅读。
Scene 4 (6.4–9.0s): 左上落最后一句「一年以后，你能证明的不是哪行代码是你写的。」
完全静止读满 2.4s。这是全片落点。


narrativeRole: **贯穿对象在这里收束**——F4 记下的那份要求，最后变成了一份关于人的记录。
这是全片落点，也是赛题「人还在场」第二层的答案。
keyMessage: 归因人的判断，不归因代码行。
handoff_in: "requirement-rail — 从 F6 的左栏位置收拢至报告条目行 x:672 y:412，scale 0.62，opacity 1"

## Frame 12 — 看着办

- scene: 纸底，品牌标 + 名称 + 一句话，静止收尾
- voiceover: ""
- titles: "看着办" / "Agent 办事，人看得见，也能介入。" / "Build with Care · 赛道三"
- duration: 5s
- transition_in: zoom-through
- status: built
- src: compositions/frames/f12-outro.html
- type: branding
- persuasion: —
- beat: 落定
- asset_candidates: assets/brand-mark.svg — 产品内 BrandMark：四个开放视框角 + 一笔判断线
- blueprint: titlecard-reveal (Adapt)
- focal: assets/brand-mark.svg
- roles: brand-mark = cutout
- music_cue: 0.0s 余韵延续；2.0s 收尾单音；4.5s 静
- sfx: —

Adapt: 保留"一次克制的动作后完全静止"的结构；借构图规则 4 的叠压关系收尾——
三个平面（要求 / 对账 / 判断）**互相叠压、全部正面、共享同一张纸**，说明它们是一件事。
Scene 1 (0.0–1.8s): 三个平面从画面下缘依次叠上来并停住，全部正面、无倾斜、近乎无影；
它们共享同一张纸色底，边缘只有 `line` 细线。
Scene 2 (1.8–3.4s): 品牌标（产品内 BrandMark：四个开放视框角 + 一笔判断线）在三层之上落位，
判断线用 `svg-path-draw` 画出——这是全片最后一个动作。
Scene 3 (3.4–5.0s): 「看着办」与「Agent 办事，人看得见，也能介入。」左对齐落位；
右下角小字「Build with Care · 赛道三」。**整帧完全静止**至结束。


narrativeRole: 干净的结束画面，不再新增信息。

---

## 数字出处

全部取自 `frontend/.data/runs/1844987c-.../state.json`（任务「帮我构建一个网页版超级马里奥」，
status: completed，revision v3）：

| 片中数字 | 字段 | 值 |
|---|---|---|
| 13 条要求 · v3 | `constraints` 中 `active` 者 / `revision` | 13 / 3 |
| 28 个工作单元 | `workUnits` | 28 |
| 111 步 | `steps` | 111 |
| 17 个自主决定 | `decisions` | 17（conflict 6 · uncertain 5 · choice 6） |
| 11 次闸口，8 次拦停 | `gates` | 11（denied 8 · allowed 2 · expired 1） |
| 10 次判断 | `interventions` | 10（enforce 6 · allow-once 2 · correct 2） |
| 8 次纠正了做法 | 带 `subsequentStepIds` 的 intervention | 8 |
| 三条验证证据 | `verifications` 中该产物当前有效项 | HTML 基本结构 / 内联 JavaScript 语法 / 无外部页面资源 |

## 不出现在片中的东西

- 任何 fork / branch / 回滚画面——首版只公开 forward-only。
- 任何"已接入真实异源模型判官"的暗示。
- 任何 dsh 已接入运行时的暗示。
- 任何把剪辑速度包装成实测性能的表达（F5 的加速是叙事节奏，不叠速度数字）。
- 「停止任务」的使用次数——这次没用到。
