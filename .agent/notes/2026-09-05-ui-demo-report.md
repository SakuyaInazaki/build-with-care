# Agent Notes · 2026-09-05 · 工作台、完整演示与报告

## 变动

- 重做 `src/public/index.html` 为中文单页工作台：创建/选择 session、短 spec 确认、模式锁定提示、双栏过程对账、红卡逐卡裁决、蓝卡侧栏、分支面板、全局时间线和打印报告。
- 每个 step 默认显示粗粒度的“人说了什么 / Agent 实际做了什么”，通过原生 `details` 展开 tool call、executor result、evidence、judge/recorder 来源和置信度。
- 增加 timeline 的 agent、branch、event type 过滤，以及上一步、下一步、自动播放和进度条。动态内容全部使用 `textContent`、`createElement`、事件监听和 `replaceChildren`，没有 `innerHTML`、inline onclick 或字符串拼接 HTML。
- 页面显式区分红、蓝、灰、green、runtime failure 和 recording drift；人工复核会记录为非受控 evidence，不会伪装成 green。
- 完整演示动作会创建新 session，固定执行蓝卡缓存选择、SQLite 红卡阻断、按当前模式 forward correction 或 fork、Postgres schema 写入和本地 validate evidence。它不依赖模型，不把 dsh 或异源 provider 假装接入。
- `src/stream.ts` 为 `validate` 动作增加本地 executor 检查 evidence；fork 时父分支置为非活动，便于 UI 明确显示父子分支。
- `SessionReport` 增加 executor evidence、不可逆副作用、未验证、记录失败和纠偏前后对比；`GET /timeline` 增加 branch/event type 查询参数。
- 新增 `src/ui-flow.ts` 与 `src/ui-flow.test.ts`，用纯函数锁住完整演示阶段顺序和粗粒度 timeline 分组。
- 重写 README，补充 Implemented / Simulated / Not implemented、启动与 demo 步骤、API、安全边界、两种模式、测试范围及 dsh/异源模型/Git adapter 限制。

## 理由与影响

- 之前页面只能执行单个动作，不能现场讲清楚“人的输入、Agent 的动作、判色、裁决、证据和回放”之间的关系；现在这些信息在一页中按工作流分层呈现，桌面双栏、移动端单栏。
- 完整演示采用稳定的本地动作序列，避免等待外部模型或依赖模型偶然犯错；红卡仍由现有 deterministic judge 真实产生，工具写入和验证由受控 executor 真实完成。
- 仍然保留 append-only timeline 原顺序和原动作，不在 UI 层覆盖历史。forward-only 与 rewind-and-fork 的差异被作为不可切换的 session 属性展示。
- 报告把“动作执行成功”和“有可信验证证据”分开，避免把无报错误判为 green；不可逆 side effect 和 recorder drift 也不会混入普通运行失败。

## 限制

- 浏览器页面仍是本地单用户 UI；服务边界不是认证系统，不能通过反向代理公开。
- deterministic judge/recorder 只是无模型 fallback。真实 dsh `pre-execute`、`inject`、`cancel`，异源记录员 provider 和准确率评测仍未接入。
- 默认 workspace executor 会在当前工作区写入演示用 `store/db.sql` 等文件；逻辑 fork 不还原物理文件，也不撤销邮件、网络请求或已运行命令。
- timeline 回放是事件可见性回放，不会重放工具副作用；报告打印使用浏览器打印能力，不提供外部导出档案。

## 验证

- `npm run typecheck`：通过。
- `npm test`：通过，4 个测试文件、23 个测试。
- `npm run build`：通过，静态页面复制到 `dist/public`。
- UI/API 核心演示路径由 `ui-flow.test.ts`、`stream.test.ts` 和 `server.test.ts` 分别覆盖；真实浏览器布局仍需在现场按 README 的完整 Demo 步骤彩排。
