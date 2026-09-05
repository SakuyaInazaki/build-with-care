# 看着办 · 新前端

从空白文件新建的 React / TypeScript / Vite 工程。项目名称经用户确认采用“看着办”。设计依据 Apple Design 和本机 Refactoring UI，业务语义以 `../docs/requirements-v1-frozen.md` 为准。

## 启动

需要 Node.js 24.14.1 或更新版本，以及 `decision-desk/` 后端依赖。

```sh
# 从仓库根目录运行
pnpm --dir decision-desk install --frozen-lockfile
npm --prefix frontend ci
npm run dev
```

打开 http://127.0.0.1:4317。开发模式同时提供新前端和 `/api/runs` 后端，支持热更新。生产预览：

```sh
npm run build
npm start
```

`PORT` 可指定本机端口。默认数据目录为 `frontend/.data/runs/`，不混入旧实现的数据。需要已有记录时显式设置 `DATA_DIR`；活动记录在服务重启后按中断处理，不会自动继续旧调用。物理删除的独立审计位于数据根目录旁的 `runs.deletion-audit.jsonl`。

## 欢迎页

直接打开 `/welcome`，或点击工作台左上角品牌按钮，可在应用内进入 “Build with Care” 纸墨欢迎页。首次访问且没有未完成任务时，根路径会转到欢迎页；已进入过欢迎页或存在 ready、运行中、等待处理、中断或错误任务时直接显示工作空间。完成滚动后点击“进入「看着办」”会用浏览器 History API 转到 `/`，不刷新页面；浏览器后退会恢复欢迎页。显式打开欢迎页时，待处理卡片仍位于欢迎页上方，点击可直接进入对应任务。

滚动进度同时控制文字退场、纸墨粒子汇成加厚 D 和反向还原。系统开启减少动态效果时改用静态端点交叉淡化；WebGL 初始化失败或上下文丢失时显示随滚动出现的静态 D，并保留入口。组件卸载会停止动画帧、移除监听和观察器并释放图形资源。

粒子使用固定版本 `three@0.180.0` 和 `@types/three@0.180.0`。Three.js 采用 MIT 许可证，并构建为仅在欢迎页挂载时加载的独立块。

## 模型配置

在“模型与设置”中选择 **DeepSeek**，输入一份 API 密钥，并分别选择执行与审查模型。官方地址与来源自动填写。预置 DeepSeek V4 Flash / V4 Pro，默认 Flash；模型标识依据 [DeepSeek 官方文档](https://api-docs.deepseek.com/)。

使用其他 Chat Completions 兼容服务时选择 **自定义服务**，分别填写接口地址、模型名称、来源及密钥。允许执行与审查使用不同服务。

也可在后端 `.env` 中仅配置 `DEEPSEEK_API_KEY`，两个角色共用该密钥；角色专用配置仍优先，自定义端点不会自动使用此密钥。查看 `decision-desk/.env.example`。保存配置本身不调用模型，测试连接需单独点击。

网页保存的模型、接口、密钥与等待时限会持久写入数据根目录的 `.settings.json`（默认 `frontend/.data/runs/.settings.json`），刷新与服务重启后继续使用。文件权限为 0600，仅当前系统用户可读写；它不属于任务工作区，不包含在任务导出中，并由 `.data/` 的 Git 忽略规则排除。已保存配置优先于环境变量；环境变量在首次配置时提供默认值。

运行中保存模型配置，从下一次执行或审查请求开始使用新配置；已经发出的请求继续使用发出时的配置，不会因保存而取消。过程时间线按每次请求的实际模型记录，历史记录不随当前模型改变。

DeepSeek 执行与审查模型可分别选择推理强度：关闭、低、高（默认）、最高。配置会映射到官方 thinking / reasoning_effort 请求字段并持久保存。执行和审查使用真正的 SSE，不设置固定总截止时间，由用户主动停止或实际请求错误结束。审查的 8 秒等待配置改为慢响应提示阈值；动作仍须等待实际审查完成。人工审批十分钟到期设置独立保留。该语义变化见 `.agent/notes/2026-09-05-streaming-review-recovery.md`。

任务失败、停止或中断后使用“继续任务”。该操作沿用已确认要求与当前文件，开启新一轮执行，不增加需求或约束版本，不直接重放旧调用。“补充要求”只用于真实的需求变化。

活动任务中的技术审查错误使用“重试审查”，保留同一个待执行动作和完整参数，重新核对当前要求，不重新请求执行模型。此等待期间仍可停止任务或更新连接设置。

## 结构与行为

- `src/App.tsx`：新任务入口、导航、流式状态与错误恢复。
- `src/components/Intake.tsx`：逐轮澄清与最终确认。
- `src/components/Board.tsx`：状态分栏、独立待定调用、非模态双栏详情和人工操作。
- `src/lib/board.ts`：根据实际状态和绑定证据计算卡片归属；人工认可不会变绿。
- `src/components/Records.tsx`：成果预览、文件检查、复盘、导出和删除。
- `src/components/Activity.tsx`：横向过程时间线和按需加载的完整关联记录。
- 时间线顶层按工作单元展示，点击后才展开单元内的详细事件和原始记录；旧记录不伪造单元。需求澄清可勾选一项或多项，并同时填写补充回答。
- 右上角可开启桌面提醒，需浏览器允许通知。网页保持打开时，待判断、审查重试、任务中断及澄清确认会显示页面提示；离开页面焦点后发送一次系统通知。等待验证和未审阅蓝卡不触发。通知可关闭，点击返回对应任务；网页完全关闭后不提供推送。
- `src/components/RunProgress.tsx`：实际模型生成阶段、已接收字符数和审查等待状态。
- `src/components/ShuffleLabel.tsx`：`shuffle-text@0.6.0` 的一次标题动效，支持减少动态效果与静态读屏文本。

新前端不导入旧前端的 App、组件或 CSS。产品启动入口统一为 `decision-desk/server/`；旧 `src/server.ts` 也转到该服务，已移除根目录的 legacy 启动脚本。旧 HTTP 工厂只保留供历史契约测试使用。

当前后端通过 `begin_unit` / `end_unit` 管理语义工作单元，核对声明的工具顺序、写入文件范围和可识别的决策差异；每次审查只携带本单元历史和当前有效要求。看板按单元聚合新记录；旧任务保留原记录。四栏均支持收起和独立滚动，“已验证”默认收起，折叠不改变业务状态或删除记录。

字体暂用系统栈，macOS 中文可使用本机苹方，不下载或分发 Apple 字体。

## 检查与边界

```sh
npm --prefix frontend test
npm --prefix frontend run build
node frontend/tests/intake.browser.mjs # 隔离 Chrome 回归，需已安装 decision-desk 依赖和 Chrome
node frontend/tests/notifications.browser.mjs # 模拟通知 API，不申请真实系统权限
cd decision-desk
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

前端状态证据测试及后端单元／集成测试覆盖 Grill、模型配置持久化、删除与工具调用后续请求。浏览器检查使用独立临时数据和本机假模型，不能算作真实模型验收。

尚未完成冻结要求的 24/24 评测与 3 次真实闭环。单元声明、顺序与范围校验、单元间审查隔离已接入并通过本机集成测试；不等于任意语义规则都能确定性识别。服务端 token 现与 cookie 一样在 24 小时到期，状态流到期后关闭并由前端重新 bootstrap。仍缺工具全集、检查并行、完整重复违规与阻塞求助、全链路保存前脱敏和通用功能验证。`run_command` 只接受 `node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build`；后三项直接在 Host 执行任务控制的 `package.json` scripts，没有 OS 隔离。人已明确接受这一当前边界并要求保留现有构建方式；产品不把它称为沙箱或隔离执行。`verify_app` 当前是列举范围的静态检查，不能视为完整功能测试。旧协议数据尚无自动导入。完整核查见 `../.agent/notes/2026-09-05-backend-runtime-release-audit.md`，这些限制不通过页面解释文案来替代实现。

所有新增选择及展示调整记录在 `../.agent/notes/`。
