# Final Product Acceptance v2

日期：2026-09-05

## 验收基线

- 已读取三份 requirements 对齐记录：`requirements-alignment.md`、`requirements-alignment-S.md`、`requirements-alignment-Y.md`。
- 已读取 `docs/` 下全部文档（包括 `api-contract-v2.md`、`work-unit-design.md`、所有 research raw 文档、项目说明、路演和 checklist），以及 `.agent/notes/` 下验收前已有的 11 份 notes。
- 已审阅当前完整未提交 diff。没有提交 commit。
- dsh 基线为 `/Users/sakimi/Desktop/DSH/deepseek-harness`，HEAD `d347e703908d0406b7a7ef80e3a0e594d86b2215`，tag `dsh-v0.1.3-alpha.1`。

## 修复

### dsh 外部执行回写

发现插件调用的 `/api/sessions/:id/adapter-events` 原先没有服务端路由，`tools/result` 因而只能本地记录，不能回写工作台；此外带 `args.unitId` 的后续 dsh tool call 会被错误创建成新卡；dsh unit 也会被本地 executor 重复执行。

修复文件：

- `src/server.ts`
  - 增加 `/adapter-events` 路由。
  - `/actions` 检测 `args.unitId`，改走 `executeInUnit`，保持同一张工作单元卡。
- `src/stream.ts`
  - dsh 来源的 unit 只做 admission，不在工作台本地执行。
  - dsh 后续工具调用保持同一 unit，只有收到真实 `tool-result` 才更新 succeeded/failed、evidence、green 和 turn-end。
  - 未匹配的 dsh result 返回 `unknown_external_call`，不会伪造成功。
  - dsh lifecycle 事件以 `adapter-event` 进入 append-only timeline。
- `src/server.test.ts`
  - 新增 dsh admission 不产生假 `tool-result`、多工具同 unit、post/result 回写和 executor evidence green 的回归测试。
- `docs/api-contract-v2.md`
  - 补充 `/adapter-events` 契约及“tool-result 是外部执行成功的唯一权威来源”。
- `integrations/dsh-plugin/src/workbench-client.ts`
  - 更新 adapter-events 路由说明。

未弱化任何原有 policy：`specified=true` 仍不能压过 deterministic red；人工 verify 仍不能变 green；ask-user 仍由 monotonic guard 和 pre-execute 双禁用。

## 主项目命令

最终修复后执行：

```text
npm run typecheck   PASS
npm test            PASS: 13 test files, 82 tests
npm run build       PASS; rebuilt dist from current src
git diff --check    PASS
```

## 插件命令

安全链接命令及结果：

```text
DSH_CLONE=/Users/sakimi/Desktop/DSH/deepseek-harness npm run link-dsh
```

成功链接 264 个 dsh package 到插件自己的 repository-local `node_modules`；脚本校验精确版本和 commit，不读取或写入 `~/.dsh`，不链接外部 `node_modules`。

```text
npm run typecheck   PASS
npm test            PASS: 5 test files, 13 tests
npm run build       PASS
npm run smoke       PASS: real 0.1.3-alpha.1 Cordis Loader composition; ask_user_question body not executed
npm pack --dry-run  PASS: 12 package files; only README, patch, package manifest and dist
git diff --check    PASS
```

插件测试总数为 13；主项目与插件合计 95 tests passed。

## HTTP/服务完整链路

使用当前源码重新 `npm run build` 后，通过 `dist/server.js` 启动临时 127.0.0.1 服务；未使用旧 dist。使用临时独立 data root，验收结束已删除该临时目录。

通过项目：

- 创建 session、模式锁定、未确认 spec 执行动作返回 409。
- `spec/draft` 模板 fallback，确认 `structuredConstraints` 始终生成。
- 蓝、红、灰、executor evidence 后的绿状态；`specified=true` 无法绕过真实红冲突。
- 一个 work unit 内多个 tool call 按序执行，并验证证据后转 green。
- 红卡逐卡裁决、forward-only 只新增未来约束，不改历史。
- rewind-and-fork：父分支保留且 inactive，子分支 active，fork/injection 事件和 origin 正确。
- 人工 constraint 注入、session cancel、pending card 取消和 session end。
- cancel 后迟到 executor 成功不会覆盖 cancelled 状态。
- session-end 后不再追加事件；结束后 action 返回 409。
- timeline `eventType`/`since` 查询、branches、report、互斥颜色桶。
- SSE 首帧 `event: state`；验收脚本按 chunk 累积读取，避免把合法的分片响应误判为缺失事件。
- 关闭服务再用同一 data root 重启，timeline/state 持久化恢复。
- `/app.js`、`index.html`、`styles.css` 与全部静态 module 共 12 个资产 HTTP 200。

独立补充命令通过：

- rewind-and-fork + pending cancel HTTP probe：PASS。
- 静态 JS 全部 `node --check`：PASS。

## 回归项

- `specified=true` 不能绕过：PASS，指定 SQLite 仍 pending/red。
- validate 不能伪绿：PASS，只有 executor 绑定 passed evidence 转 green；人工 verify 不转 green。
- cancel 后迟到成功不能覆盖：PASS，AbortSignal 后强制以取消结果为准；adapter 结果仅在匹配的真实调用完成时更新。
- session-end 后无事件：PASS，`addEvent` 冻结且 `/timeline?since=endSequence` 为空。
- 报告颜色不重复：PASS，verified 只进 green，failed 只进 failed，其余按 verdict 色桶。
- 未配置 run：PASS，返回 409 `llm_not_configured`；UI 也按 config 禁用真实模型按钮。
- `ask_user_question`：PASS，loader composition 中 force-allow listener 不能绕过 guard/pre deny，工具 body 未执行。
- dsh pre 不记假成功：PASS，dsh unit admission 只写 tool-call/运行中状态，不写 tool-result；只有 post/result 的最终 result 回写成功或失败。
- dsh post/result 回写：PASS，两个 dsh tool call 保持一个 unit，result/evidence 回写后才 succeeded/green。

## 前端、安全和资产

- 没有可用浏览器自动化环境，因此未声称真实浏览器渲染验收；已做完整静态 module/import、HTTP 资产和 `node --check` 验证。
- 移动 CSS 已检查 `960px` 单列、`560px` 顶栏换行、横向操作区、触控最小高度、dialog/dock 窄屏布局。
- 键盘可访问性已检查 skip link、原生 button/form/details/dialog、radio semantics、`focus-visible`、aria labels/live regions；动态控件无 inline handler。
- XSS sink 搜索只发现 `dom.js` 明确拒绝 `html` 属性的保护代码；未发现 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`eval`、`new Function` 或 `document.write` 使用。动态文本走 `textContent`/`createTextNode`。

## 生成物、敏感信息和锁文件检查

- `.gitignore` 已忽略 `dist/`、`node_modules/`、`.decision-stream/`、store 和根 demo SQLite 文件；验收没有删除用户已有无关文件。
- 仓库中存在既有 ignored `dist/`、SQLite、`.decision-stream/` 和插件 `node_modules`/`dist`，均未作为源码或 npm 包内容误提交；插件 dry-run 仅打包预期 12 个文件。
- 未发现 `.env`；`.env.example` 只含配置名和示例占位值。源码/测试中的 `sk-test`、`sk-secret-*` 是测试 fixture，不是真实凭据；没有发现真实密钥。
- 主项目和插件 lockfile 均与各自 package manifest 一致；没有新生成的错误 lockfile。

## 剩余边界

- 没有在真实 DeepSeek 模型、有真实凭据和网络的条件下跑完整模型 E2E；本次 dsh 验收是锁定 checkout 的真实 Loader/composition、插件测试和 smoke，不冒充完整模型运行。
- dsh 上游 checkout 的全量 host bundle build 仍有既有缺失导出问题，插件自身 typecheck/test/build/smoke 不受影响。
- rewind-and-fork 仍是逻辑分支；没有物理 workspace snapshot，也不能撤销邮件、网络请求或其他外部副作用。
- 本服务仍是 loopback 单用户原型，不是认证、CSRF 或多进程高并发部署方案。
- 没有浏览器自动化覆盖真实布局、console 和屏幕阅读器；已完成静态 import/HTTP/语法验证，需现场浏览器彩排补充视觉验证。
