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

## 模型配置

在“模型与设置”中选择 **DeepSeek**，输入一份 API 密钥，并分别选择执行与审查模型。官方地址与来源自动填写。预置 DeepSeek V4 Flash / V4 Pro，默认 Flash；模型标识依据 [DeepSeek 官方文档](https://api-docs.deepseek.com/)。

使用其他 Chat Completions 兼容服务时选择 **自定义服务**，分别填写接口地址、模型名称、来源及密钥。允许执行与审查使用不同服务。

也可在后端 `.env` 中仅配置 `DEEPSEEK_API_KEY`，两个角色共用该密钥；角色专用配置仍优先，自定义端点不会自动使用此密钥。查看 `decision-desk/.env.example`。保存配置本身不调用模型，测试连接需单独点击。

网页保存的模型、接口、密钥与等待时限会持久写入数据根目录的 `.settings.json`（默认 `frontend/.data/runs/.settings.json`），刷新与服务重启后继续使用。文件权限为 0600，仅当前系统用户可读写；它不属于任务工作区，不包含在任务导出中，并由 `.data/` 的 Git 忽略规则排除。已保存配置优先于环境变量；环境变量在首次配置时提供默认值。

DeepSeek 执行与审查模型可分别选择推理强度：关闭、低、高（默认）、最高。配置会映射到官方 thinking / reasoning_effort 请求字段并持久保存。执行请求没有固定总时限，由用户主动停止或实际请求错误结束；审查和审批时限独立保留。

任务失败、停止或中断后使用“继续任务”。该操作沿用已确认要求与当前文件，开启新一轮执行，不增加需求或约束版本，不直接重放旧调用。“补充要求”只用于真实的需求变化。

## 结构与行为

- `src/App.tsx`：新任务入口、导航、流式状态与错误恢复。
- `src/components/Intake.tsx`：逐轮澄清与最终确认。
- `src/components/Board.tsx`：状态分栏、独立待定调用、非模态双栏详情和人工操作。
- `src/lib/board.ts`：根据实际状态和绑定证据计算卡片归属；人工认可不会变绿。
- `src/components/Records.tsx`：成果预览、文件检查、持久化时间线、复盘、导出和删除。
- `src/components/ShuffleLabel.tsx`：`shuffle-text@0.6.0` 的一次标题动效，支持减少动态效果与静态读屏文本。

新前端不导入旧前端的 App、组件或 CSS，仅复用后端数据契约。原入口保留为根目录 `dev:legacy`、`build:legacy`、`start:legacy`。

字体暂用系统栈，macOS 中文可使用本机苹方，不下载或分发 Apple 字体。

## 检查与边界

```sh
npm --prefix frontend test
npm --prefix frontend run build
cd decision-desk
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
```

前端状态证据测试及后端单元／集成测试覆盖 Grill、模型配置持久化、删除与工具调用后续请求。浏览器检查使用独立临时数据和本机假模型，不能算作真实模型验收。

尚未宣称完成冻结要求的 24/24 评测与 3 次真实闭环。既有后端仍有冻结前的边界：工作单元隔离和超长上下文、工具全集与独立安全策略、全链路脱敏、约束修改后的全量重新审查仍需单独核验。`verify_app` 当前是列举范围的静态检查，不能视为完整功能测试。这些限制不通过页面解释文案来替代实现。

所有新增选择及展示调整记录在 `../.agent/notes/`。
