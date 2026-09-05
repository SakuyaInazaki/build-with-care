# 看着办 · Agent 工作台

当前产品只有一个启动链路：`frontend/` → `decision-desk/server/` → dsh。需求与验收以 [冻结基线](docs/requirements-v1-frozen.md) 及后续人工确认的 [.agent/notes](.agent/notes/) 为准。

```sh
pnpm --dir decision-desk install --frozen-lockfile
npm --prefix frontend ci
npm run dev
```

默认打开 http://127.0.0.1:4317。生产使用 `npm run build`、`npm start`；`PORT` 可指定端口。`npm test` 和 `npm run typecheck` 检查当前后端与前端。`npm run test:reference` 只测试历史参考模块，不代表当前产品验收。

## 纸墨欢迎页

`/welcome` 可直接打开 “Build with Care” 纸墨欢迎页，工作台品牌按钮也会在应用内进入该路由。首次访问且没有未完成任务时会先显示欢迎页；已进入过或存在未完成任务时直接打开工作空间。完成滚动并点击“进入「看着办」”会在应用内转到 `/`，不刷新页面；浏览器后退可回到欢迎页。显式访问欢迎页时，待处理提醒仍显示在页面上，并可直接进入对应任务。

欢迎页支持反向滚动还原、系统减少动态效果偏好和 WebGL 不可用／上下文丢失时的静态 D 回退。Three.js 与类型声明固定为 `0.180.0`，采用 MIT 许可证；Three.js 产物按需加载，工作空间会话不会预先下载该块。

当前运行链已接入旧实现的工作单元声明、结构化约束匹配和受控命令执行。新任务通过 `begin_unit` 声明语义目标、决策及顺序计划，执行后用 `end_unit` 关闭；Host 检查工具顺序、文件范围和已识别的声明差异。每次审查只使用当前单元材料及有效要求，不使用其他单元的近期记录。模型审查失败仍保持未执行，规则冲突不能被模型允许结论覆盖。

现有 `/api/runs`、任务文件、时间线和模型设置保留。旧 `src/server.ts` 转到同一个后端；原 `/api/sessions` HTTP 工厂移入 `src/reference-server.ts`，仅供历史契约测试。旧协议数据尚未提供自动导入，历史文件保留。旧演示、旧测试、旧验收说明不等同于当前产品能力。

**尚未达到冻结首版验收标准。** 仍缺 dsh 工具全集与并行检查、完整的重复违规/阻塞求助策略、全链路保存前脱敏、通用功能验证与三次真实闭环验收。服务端进程会话 token 现与 cookie 一样在 24 小时到期，状态流届时关闭并由前端重新 bootstrap。当前检查覆盖 HTML、JavaScript、CSS、JSON 的格式／语法及 Markdown、文本的可读取性与当前哈希，不等于通用功能验证。`run_command` 仅接受 `node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build`；后三项会在 Host 上直接执行任务控制的 `package.json` scripts，没有 OS 隔离，可能访问网络、本机资料、工作区外路径或留下后代进程。人已明确接受当前边界并要求保留现有构建方式，文档和界面不把它称为沙箱或隔离执行。完整状态见 [缺口核查](.agent/notes/2026-09-05-current-product-gap-audit.md) 和 [后端发布审计](.agent/notes/2026-09-05-backend-runtime-release-audit.md)。

[使用与数据说明](frontend/README.md) · [历史实现参考](docs/legacy-implementation-reference.md)
