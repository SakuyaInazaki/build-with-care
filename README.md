# 看着办 · Agent 工作台

当前产品只有一个启动链路：`frontend/` → `decision-desk/server/` → dsh。需求与验收以 [冻结基线](docs/requirements-v1-frozen.md) 及后续人工确认的 [.agent/notes](.agent/notes/) 为准。

```sh
pnpm --dir decision-desk install --frozen-lockfile
npm --prefix frontend ci
npm run dev
```

默认打开 http://127.0.0.1:4317。生产使用 `npm run build`、`npm start`；`PORT` 可指定端口。`npm test` 和 `npm run typecheck` 检查当前后端与前端。

## 三种交付形态

| 形态 | 给谁 | 怎么来 |
|---|---|---|
| **公开演示站** | 评委／任何人，点链接就能用 | `deploy/` 下的脚本部署到服务器，详见 [部署手册](deploy/README.md) |
| **免安装离线包** | 想在自己机器上跑完整能力的人 | `node scripts/package-release.mjs` → `release/` 下四个分平台压缩包（macOS arm64 / macOS Intel / Windows / Linux，48–57 MB）。**自带 Node 运行时，目标机器什么都不用装**，解压双击即可 |
| **源码** | 要读代码、要改的人 | 下面的开发命令 |

离线包里的服务端是预编译好的 JavaScript，运行时不依赖 `tsx`／esbuild 的平台原生二进制，所以应用代码本身三平台通用，只有 Node 运行时（v24.20.0，放在包内 `runtime/`）按平台分发。启动脚本只用包内的运行时，不碰系统里的 Node。用 `--no-runtime` 可以打一个不含运行时的通用包（体积 14 MB，但要求目标机器自备 Node 24+）。使用说明见 [离线包使用说明](docs/离线包使用说明.md)。

行为验证需要本机有 Chrome／Chromium／Edge（可用 `CHROME_PATH` 指定）。找不到浏览器时验证会明确报告"没有可用浏览器"，不会伪造成通过。

公开展示站是**只读**的：只接受 GET，任何写操作一律拒绝。访客翻看的是真实模型跑出来的会话记录——决策卡、双栏对账、时间线、结束报告、以及 agent 做出来的成品页面；创建任务与模型配置入口在界面上直接隐藏。想自己跑一遍就用离线包。这样做是因为单实例匿名部署里没有一种写操作是安全的（共享密钥、宿主机执行、共用记录），只读是唯一诚实的边界。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `4317` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；容器／服务器部署设为 `0.0.0.0` |
| `ALLOWED_HOSTS` | 空 | 除 localhost 外允许调用 `/api` 的 Host，逗号分隔（如 `101.201.125.231:8080`）|
| `PUBLIC_DEMO` | 空 | 设为 `1` 开启公开演示站护栏 |
| `DATA_DIR` | `.data/runs` | 会话记录目录 |
| `CHROME_PATH` | 自动探测 | 行为验证使用的浏览器可执行文件 |
| `CHROME_ARGS` | 空 | 追加给浏览器的启动参数（容器里需要 `--no-sandbox`）|

`npm run test:reference` 单测仓库根 `src/` 下的模块。注意 `src/stream.ts` 与 `src/work-unit.ts` 并非历史遗留：`decision-desk/server` 在运行时确实 import 它们，打包与部署都必须带上根目录的 `src/`。

## 纸墨欢迎页

`/welcome` 可直接打开 “Build with Care” 纸墨欢迎页，工作台品牌按钮也会在应用内进入该路由。首次访问且没有未完成任务时会先显示欢迎页；已进入过或存在未完成任务时直接打开工作空间。完成滚动并点击“进入「看着办」”会在应用内转到 `/`，不刷新页面；浏览器后退可回到欢迎页。显式访问欢迎页时，待处理提醒仍显示在页面上，并可直接进入对应任务。

欢迎页支持反向滚动还原、系统减少动态效果偏好和 WebGL 不可用／上下文丢失时的静态 D 回退。Three.js 与类型声明固定为 `0.180.0`，采用 MIT 许可证；Three.js 产物按需加载，工作空间会话不会预先下载该块。

当前运行链已接入旧实现的工作单元声明、结构化约束匹配和受控命令执行。新任务通过 `begin_unit` 声明语义目标、决策及顺序计划，执行后用 `end_unit` 关闭；Host 检查工具顺序、文件范围和已识别的声明差异。每次审查只使用当前单元材料及有效要求，不使用其他单元的近期记录。模型审查失败仍保持未执行，规则冲突不能被模型允许结论覆盖。

现有 `/api/runs`、任务文件、时间线和模型设置保留。旧 `src/server.ts` 转到同一个后端；原 `/api/sessions` HTTP 工厂移入 `src/reference-server.ts`，仅供历史契约测试。旧协议数据尚未提供自动导入，历史文件保留。旧演示、旧测试、旧验收说明不等同于当前产品能力。

**尚未达到冻结首版验收标准。** 仍缺 dsh 工具全集与并行检查、完整的重复违规/阻塞求助策略、全链路保存前脱敏、通用功能验证与三次真实闭环验收。服务端进程会话 token 现与 cookie 一样在 24 小时到期，状态流届时关闭并由前端重新 bootstrap。当前检查覆盖 HTML、JavaScript、CSS、JSON 的格式／语法及 Markdown、文本的可读取性与当前哈希，不等于通用功能验证。`run_command` 仅接受 `node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build`；后三项会在 Host 上直接执行任务控制的 `package.json` scripts，没有 OS 隔离，可能访问网络、本机资料、工作区外路径或留下后代进程。人已明确接受当前边界并要求保留现有构建方式，文档和界面不把它称为沙箱或隔离执行。完整状态见 [缺口核查](.agent/notes/2026-09-05-current-product-gap-audit.md) 和 [后端发布审计](.agent/notes/2026-09-05-backend-runtime-release-audit.md)。

[使用与数据说明](frontend/README.md) · [历史实现参考](docs/legacy-implementation-reference.md)
