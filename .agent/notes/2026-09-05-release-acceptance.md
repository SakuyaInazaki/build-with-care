# 发布验收与仓库卫生审计

日期：2026-09-05 至 2026-09-06

## 结论口径

当前代码可作为继续收敛的可用候选版本，但不能称为冻结首版正式验收完成。正式门槛是 24/24 项评测、3/3 次真实模型闭环且至少一次真实红卡；本轮没有用单元测试、模拟上游或浏览器夹具替代这些门槛。

## 当前自动检查

| 检查 | 结果 | 证据与边界 |
| --- | --- | --- |
| 当前后端与前端测试 | PASS | 最终源码下产品后端 62/62、前端 14/14 通过；另外旧参考运行时 82/82 通过，后者单独记录，不并入产品测试数。隔离浏览器脚本需要临时 loopback 监听，沙箱内 `listen EPERM 127.0.0.1` 后以同一既有脚本允许 loopback 重跑通过。 |
| 类型检查 | PASS | 产品后端、前端构建内的 TypeScript 检查和旧参考运行时类型检查均通过。 |
| 生产构建 | PASS | paper landing、最终看板归属、任务记录分离、归档与 Grill 批量界面合并后生产构建通过。主工作空间 288.28 kB（gzip 91.35 kB），按需 Three.js 块 704.69 kB（gzip 180.10 kB）；Vite 给出单块超过 500 kB 警告，不影响构建退出码。返回用户直达工作空间时浏览器确认没有请求 Three.js 块。 |
| diff 空白检查 | PASS | `git diff --check` 通过。 |
| 既有 intake 浏览器回归 | PASS | 隔离 Chrome：多选、单选、仅自由输入、取消勾选、失败保留、换题清空、无轮次设计说明；工作单元概览、单元隔离、按需完整原始记录、收起步骤。 |
| 既有 notification 浏览器回归 | PASS | 隔离 Chrome 模拟 Notification：只在点击后申请权限、后台订阅、页内提醒、后台系统通知、重复去重、点击返回、处理后关闭、关闭偏好与刷新、权限拒绝回退、单项关闭跨重放与刷新、新事项再次出现、SSE 重连更新后端能力。系统通知本身未在真实 macOS 权限链路实测。 |

## 可见组件与探索验收矩阵

以下状态只描述本轮实际执行：PASS 是已有可复现证据；FAIL 是已确认不符合；NOT EXERCISED 是没有用替代性证据冒充通过。

| 区域/场景 | 状态 | 实际证据或问题 |
| --- | --- | --- |
| 首次欢迎页：纸色、初始散布、滚动汇聚厚重 D | PASS | 最终 bundle 在 1440×960 隔离 Chrome 截取 initial / mid-D / full-D；纸色背景、两侧散布、滚动聚合与完整加厚 D 均实际可见。 |
| 欢迎页反向滚动、内部平滑收敛、进入过渡、资源释放 | PASS | 从 full-D 反滚到 `data-phase=start` 后入口移出可访问树；键盘 End 可再次形成 D。进入只产生一次初始 document 请求，URL 由 History API 变为 `/`；卸载后 landing/canvas 消失，源码清理 RAF、监听、observer、geometry、material 与 renderer。 |
| 欢迎页直达 `/welcome`、首次访问、返回用户绕过、浏览器前进后退 | PASS | 首次根路径内部转为 `/welcome`；直接 `/welcome` 可见；进入后 Back 回欢迎页、Forward 回工作空间。已进入标识的返回用户直达 `/` 且不下载 Three.js 块。 |
| 欢迎页移动端、键盘、减少动态效果、WebGL fallback | PASS | 390×844 无横向溢出，移动端使用 3600 粒子；减少动态效果下 transition 为 `0s`、进入约 218 ms；强制 WebGL 初始化失败仍形成静态 D 和可用入口。 |
| 应用名与导航 | PASS | 源码和浏览器可见名称为“看着办”；主导航是任务概览、决策看板、成果与验证、过程时间线、我的判断。 |
| 任务归档、恢复、过滤与只读查看 | PASS | v4 capability 下默认列表排除归档项并提供带数量的“已归档”入口；归档任务可查看看板、成果、时间线和判断，执行修改入口隐藏。隔离 API/浏览器覆盖归档、恢复、reload 和活动任务拒绝；真实页面只读确认 `ready(confirm)` 标题旁“归档任务”可见且启用，运行态显示禁用按钮与停止提示。归档不改变卡片分栏或验证证据。 |
| 空任务概览 | PASS | 隔离空 `runs: []` 显示“暂无任务”和“还没有任务”，桌面及 400 px 页面无横向溢出。 |
| 设置弹窗桌面/窄屏四角圆角 | PASS | 桌面和 400×760 computed `border-radius: 20px`；窄屏左右各 19 px，document scrollWidth = innerWidth = 400。Escape 关闭正常。 |
| DeepSeek 密钥、双模型选择、双推理强度、保存后刷新/重开 | PASS（模拟 API） | 浏览器实际填写共享密钥、分别选择 V4 Pro/Flash 和 max/none；请求体值准确，成功后密钥输入清空且公开设置不回显。后端现有测试覆盖 0600 持久文件与重启恢复。 |
| 自定义端点与两角色独立配置 | PASS（模拟 API） | 浏览器分别保存 `127.0.0.1`/`localhost` 端点、模型与来源；弹窗关闭重开和页面 reload 后值均保留。后端现有配置测试覆盖同端点保留密钥及换端点不复用。 |
| 设置保存/连接成功与失败恢复 | PASS | 保存显示有底色、边框和阴影的绿色 `role=status`“设置已保存”；连接成功显示同级醒目状态“连接成功，服务已返回响应”；注入 503 后显示 `role=alert` 且可继续操作。 |
| 需求澄清批量、多选、空选、自由输入与恢复 | PASS | capability 下每批三题宽屏并排、390px 纵排；隔离 Chrome 实际覆盖独立多选、部分空题、自由补充、第二批全空、最终未决门禁、失败后保留、pendingAnswers 刷新恢复、未编辑重试不覆盖、编辑后整批更新及较少题旧会话。无 capability 时既有单题协议回归通过；页面没有题数预算等实现说明。 |
| 运行进展、慢审查、审查失败重试、继续任务 | PASS（模拟与组件级） | 现有测试覆盖慢审查不放行、原地重试、取消请求和 v3 历史错误恢复；未在真实外部模型长请求上重复演示。 |
| 四色看板、等高、折叠、栏内滚动 | PASS | 最终 bundle 四栏均为 595 px；卡片背景实测红 `rgb(242,152,146)`、灰 `rgb(178,183,199)`、蓝 `rgb(145,187,243)`、绿 `rgb(133,209,171)`。长栏 clientHeight 527、scrollHeight 2765 且 scrollTop 可变；折叠/展开保留等高。 |
| 看板双栏详情、四个红卡动作、蓝卡三状态 | PASS | 浏览器点开红卡后双栏详情可见，局部精确确认四个动作各一项；蓝卡显示“未审阅/已认可”。没有单一模态遮住并列卡片。 |
| verify-only / 命令产物工作单元归属 | PASS | 修复 `unitChecks()` 后，无持久测试文件的 ad hoc 状态检查确认：completed verify-only 单元只在绑定当前文件 hash/revision 的实际 `verify_app` 证据通过后变绿；completed `run_command` 单元使用后端记录的 `artifactPaths` 并同样要求实际受控检查。前端 14/14、类型检查和生产构建复跑通过。 |
| 完成但无产物的只读工作单元 | PASS | 已完成、无决策、只包含 begin/end/list/read 的单元不再生成决策看板卡片；原 work unit、步骤与事件仍完整留在时间线。ad hoc 状态检查确认不伪造绿卡，也不误放入“已停止与已拦停”。语义记录见 `2026-09-06-read-only-unit-board-display.md`。 |
| 成果文件切换、HTML 预览、源码、刷新、全屏、独立打开 | PASS（除真实全屏权限） | 隔离浏览器确认 HTML iframe、源码切换、JS 文件切换、刷新/全屏/独立打开控件存在；注入 artifact 404 后显示“文件暂时不可用”。真实系统全屏切换 NOT EXERCISED。 |
| 验证证据：通过/失败/失效/hash | PASS | 浏览器可见受控检查条目；`board` 现有测试覆盖文件 hash、约束 revision、执行步骤绑定及旧证据失效。命令产物现在也纳入单元 path coverage，避免命令单元永远停在等待验证。最终真实状态只读复算从 validation 11 / verified 16 / closed 10 收敛为 8 / 18 / 11：一个无纠正的已取消单元正确归档，两个明确仅本次允许且已完成的单元使用当前 hash 绑定检查转绿；剩余八项都是 `progress=acted`、缺少针对性功能验证的真实纠正，继续留在等待验证。 |
| 工作单元时间线、单元钻取、完整原始记录 | PASS | 既有隔离 Chrome 断言概览不混入步骤、按单元隔离、详情按需一次请求并显示完整记录；最终变更后同一脚本重跑通过，前端 timeline 5/5 通过。真实任务只读核对还确认单元 28 的“1 步”准确，195 条单元外记录没有误归属；该合集现作为独立折叠“任务记录”显示在编号单元序列之外，成员、顺序和原始详情保持不变。 |
| 我的判断、导出、物理删除确认 | PASS（非破坏性范围） | 浏览器可见复盘内容与删除入口；后端路由存在。为保护真实任务，本轮没有实际确认删除；物理删除行为由现有后端测试提供证据。 |
| 页内/桌面通知、关闭、重放/刷新、新动作 | PASS（模拟 API） | 既有隔离 Chrome 回归通过；真实 OS 通知权限 NOT EXERCISED。 |
| 缺失 API、缺失 task、缺失 artifact、空 units/events/runs | PASS（非破坏性契约） | 浏览器直接请求不存在 API 得到 JSON 404“接口不存在”；artifact 404 显示可读错误；空 runs、空时间线概览均正常。缺失 task 的 404 由后端现有测试覆盖。 |
| 响应式、键盘焦点、减少动态效果 | PASS | 1440 桌面、390/400 px 窄屏无横向溢出；欢迎页 scroller 键盘 End、设置 Escape、原生按钮/选择框均可操作；reduced-motion 欢迎页无 transition。 |
| 缺失服务器/断线恢复 | PASS（模拟） | 初始 bootstrap 503 显示“本地服务暂时不可用”和“重新连接”；notification 浏览器回归还覆盖 EventSource error 后重新 bootstrap、更新后端版本并恢复同步。 |

浏览器探针没有写入仓库测试文件，结束后临时脚本已删除。正常路径无 page error、console error 或 failed request；强制 WebGL fallback、设置 503、缺失 artifact/API 和缺失 bootstrap 场景只出现相应的预期 404/503/WebGL console 输出，没有额外错误。

截图证据（均为隔离夹具，不含真实任务或密钥）：

- `/private/tmp/kanzheban-paper-initial.png`
- `/private/tmp/kanzheban-paper-mid-d.png`
- `/private/tmp/kanzheban-paper-full-d.png`
- `/private/tmp/kanzheban-paper-mobile-initial.png`
- `/private/tmp/kanzheban-paper-mobile-full-d.png`
- `/private/tmp/kanzheban-paper-reduced-motion.png`
- `/private/tmp/kanzheban-workspace-entered-settled.png`
- `/private/tmp/kanzheban-board-all-components.png`
- `/private/tmp/kanzheban-settings-mobile.png`
- `/private/tmp/kanzheban-grill-3x3-desktop.png`
- `/private/tmp/kanzheban-grill-3x3-mobile.png`

## 冻结 24 项正式评测状态

| 用例 | 状态 | 本轮可用证据/缺口 |
| --- | --- | --- |
| G1 | PASS | 后端 Grill 隔离测试通过。 |
| G2 | PASS | 浏览器实际批量多选、单题多选、自由输入、空选和失败恢复通过。 |
| G3 | PASS | 新会话固定两批各三题、总计六题；第一批后不能提前确认，第二批后才进入最终清单。后端既有 Grill 用例与一次性 3+3 探针通过，前端批量浏览器夹具覆盖同一边界。 |
| G4 | PASS | 后端现有确认门槛测试通过。 |
| I1 | PASS | 真实 adapter + 本机模拟上游的跨单元审查输入隔离测试通过。 |
| I2 | PASS | 同单元工具序列测试通过。 |
| I3 | PASS | 下一单元不读取前单元私有材料的现有测试通过。 |
| I4 | FAIL | 已有声明/范围/部分规则下限测试，但没有冻结要求的 dsh 工具全集；通用语义硬下限也未做完，且命令边界仍有下述逃逸。不能以现有子集计正式通过。 |
| E1 | PASS | 现有执行链测试覆盖可信只读工具直通。 |
| E2 | FAIL（候选版已接受的限制） | 当前 `run_command` 虽经过 Host 白名单与工作单元校验，但允许的 npm 生命周期命令可执行任务自己控制的 `package.json` 脚本，等价于任意进程执行；`node --version`/`npm --version` 也未证明只读。用户已明确取消产品隔离并要求保留现有构建方式，因此本项不再作为此次候选版推送前的待办，但仍是冻结正式评测失败项，不能计为安全边界通过。 |
| E3 | FAIL | README 和缺口审计均确认检查并行尚未实现。 |
| E4 | PASS | 正常 execution/choice 写入自动执行由现有链路测试覆盖。 |
| E5 | PASS | 冲突、慢审查和审查技术失败均不释放写入的现有测试通过。 |
| E6 | FAIL | 完整“普通错误第三次阻塞求助、重复违规立即暂停”策略仍未实现。 |
| E7 | PASS | 停止后取消待处理动作、迟到结果不回写成功的现有可靠性测试通过。 |
| E8 | PASS（以后续已确认语义） | 8 秒现为慢响应提示阈值，10 分钟为人工处理期限，均可设置；执行与审查请求不再用固定总截止。 |
| B1 | PASS | 状态分栏并列；所有栏可独立展开、收起和滚动。 |
| B2 | FAIL（实现子集） | 蓝卡三状态与自动继续已有测试和浏览器证据；“高影响领域”的通用识别仍主要依赖模型，没有完整独立识别/硬校验，因此正式整项不通过。 |
| B3 | PASS | 四种红卡动作由现有后端可靠性测试覆盖精确调用结果。 |
| B4 | PASS | 精确 hash、双栏详情、revision 失效重审有现有测试与组件实现。 |
| C1 | PASS | 当前主界面只公开 forward-only；未展示回滚/分支操作。 |
| C2 | FAIL（实现子集） | 当前 hash/revision/受控检查绑定、文件变化失效、人工认可不变绿均通过；一般纠正的针对性功能验证仍不完整，静态语法检查不能证明任意修补解决了原问题。 |
| D1 | FAIL（已部分加强） | `/api` 与 `/artifacts` 已有 Host/Origin、24 小时随机进程 cookie、过期拒绝、bootstrap 轮换、SSE 到期关闭；结构化凭据字段和当前配置 key 在持久化诊断中脱敏，state/events/raw/audit 为 0600，物理删除和独立审计已有。但操作 `args/arguments` 为保持恢复调用真实性而保留，源码/提示/tool 参数字符串内的未知秘密无法通用识别，历史文件未重写，所以仍不是冻结要求的全链路保存前脱敏。 |
| D2 | NOT EXERCISED | 重启中断有隔离测试；本轮未完成无故障注入的真实模型演示。 |

正式结果不是 24/24；I4、E2、E3、E6、B2、C2、D1 已确认整项失败，D2 未完成正式评测。3 次真实模型闭环及至少 1 次真实红卡也未在本轮完成，因此发布时必须使用“候选版本/原型”，不能宣称“冻结首版正式验收通过”。用户已明确取消产品隔离并保留现有 build/test 命令；这是此次候选版接受的限制，不改变 E2 的正式失败结论。

最终看板规则只修复了三张能确定归类的卡：两张已 `allow-once`、执行完成且有当前哈希检查的卡进入已验证，一张已取消单元进入已停止与已拦停。现场重算为已验证 18、等待验证 8、已停止与已拦停 11；剩余 8 张是已有后续改动但缺少针对性语义验证的历史纠正卡，不用通用静态检查把它们伪装成已验证。

## 部署与生产只读 smoke

源码提交 `8805d95bae4fe7c4737dec1558056a5607b525ac` 推送后先部署 v3；随后归档与 Grill 3+3 首批按同一空闲守卫更新到 `unified-work-units-v4`，capabilities 精确为 `task-archive-v1`、`grill-batch-v1`。切换前后三条任务分别保持 ready(confirm)、completed、completed，status、revision、files、lastEventSeq、Grill 和公开设置逐项一致，没有自动恢复模型、重新检查、归档或补造验证。

独立 disposable Chrome 对实际 4322 做了只读生产 smoke：`/welcome` 与 `/` 正常加载；session cookie 为 HttpOnly、SameSite=Strict；v4 capability 与归档导航正常；ready(confirm) 的归档按钮可见且启用但未点击；已有成果 iframe 同源响应 200 并完成页面与脚本加载；带 cookie 的直接成果读取为 200，全新无 cookie context 为 401；源码切换内容与直接读取一致。页面错误和 console error 为 0；切换任务时旧 SSE 出现一次预期 `ERR_ABORTED`，没有非预期失败请求。该 smoke 证明本次部署链、归档入口和成果认证在现有数据上可用，不改变上面的冻结评测失败项。

## Git、敏感文件、生成物与依赖卫生

- 当前分支 `feat/decision-stream-complete`，跟踪 `origin/feat/decision-stream-complete`；检查时 ahead/behind 为 `0/0`。远端地址检查未发现凭据，本报告不记录任何可能含凭据的 URL。
- 工作树包含大量已修改及未跟踪的授权实现；不能使用 `git add .`。`.pnpm-store/` 原先未忽略，本轮已在根 `.gitignore` 加入 `.pnpm-store/`。
- 真实任务与模型配置位于 `frontend/.data/`，任务产物位于 `.artifacts/`，另有 `.decision-stream/`、`store/`、SQLite、`dist/`、`node_modules/`；对应 ignore 规则实测生效。不得暂存这些路径、`.env`、真实 API 密钥、测试运行报告或临时截图。
- 仅文件名的密钥形状扫描没有发现真实凭据；唯一命中是研究文档 URL slug 中的 `sk-...` 片段，不是密钥。检查过程没有输出任何凭据内容。
- 根与前端 npm lock 通过离线 `npm ci --dry-run --ignore-scripts` 一致性检查。`decision-desk` 用仓库声明版本执行 `npx --yes pnpm@11.19.0 install --lockfile-only --frozen-lockfile --ignore-scripts --offline`，结果为 `Already up to date`，220 ms 完成；未改写 lock。全量安装树未为此验证重装。
- 已安装的 131 个唯一包清单中没有缺失 license 字段，也没有发现 GPL/AGPL/SSPL/BUSL/UNLICENSED 标记。此为本机安装树元数据检查，不是法律意见，也不替代第三方 notices 生成。
- README 对当前局限的陈述已同步：明确写出未达 24/24、未完成三次真实闭环、工具全集/并行检查/重复违规/全链路脱敏/通用功能验证缺口，也列出最终受控命令范围与 Host 无 OS 隔离的已接受风险。paper welcome route、首次/返回用户、History API、WebGL fallback、资源释放、Three.js 按需块与许可证已同步；连接成功反馈也已在实际组件中落地。

建议最终只暂存审阅过的源码、锁文件、README、明确要求保留的 notes 和根 `.gitignore`；显式排除：

```text
.env
frontend/.data/
**/.artifacts/
**/.decision-stream/
store/
db.sql
db.sqlite
**/node_modules/
**/dist/
.pnpm-store/
playwright-report/
test-results/
/private/tmp 下的验收截图与临时脚本
```

最终 staging 应使用明确文件列表或经人工审阅的目录列表，并在 commit 前复跑 `git status --short --ignored=matching`、敏感形状文件名扫描和 `git diff --cached --check`。
