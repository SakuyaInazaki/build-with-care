# DSH Plugin 0.1.3-alpha.1 Migration and Live Verification

日期：2026-09-05

## 范围

本次只修改 `integrations/dsh-plugin/**`、该目录 README 和本记录；没有修改主仓库 `src/server`、`src/stream` 或 `src/public`。没有提交 commit。

## 真实版本

本机 checkout：`/Users/sakimi/Desktop/DSH/deepseek-harness`。根 `package.json`、CLI 和核心 packages 均为 `0.1.3-alpha.1`；HEAD 为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`（短 SHA `d347e70390`，release merge）。插件 manifest、mapping 常量和 smoke 均锁定该版本与 commit，插件自身版本同步为 `0.1.3-alpha.1`。

## 旧版到 0.1.3 的 API 与布局变化

- Profile 不再以一个可编辑 `cordis.yml` 作为完整树。0.1.3 使用空 profile root，再按 `dsh.profile.bundles` 顺序应用各 package 的 `dsh.bundle.patch`、profile `cordis.patch.yml`、home/CLI overlays。第三方 package 若要通过 `dsh plugin --profile ... add` 自动进入 composition，必须在 manifest 声明 `dsh.bundle.patch`。因此插件新增并导出 `cordis.patch.yml`，patch 插入 `@decision-stream/dsh-plugin` 行。
- Cordis Loader 仍接受无 default export 的 function plugin namespace（`name`/`inject`/`apply`），但新版 Context 拒绝未通过 service `provide` 声明的属性赋值。旧实现把测试句柄写入 `ctx.decisionStreamBridge`，真实 Loader 报 `cannot set property ... without provide`；迁移后删除该写入，`DecisionStreamBridge` 类本身仍导出供测试和嵌入使用。
- `tools/pre-execute`、`tools/post-execute`、`tools/result` 的相关 payload 与 waterfall/emit 语义对本插件保持兼容；`ToolExecution` 继续提供 parsed frozen `arguments`、agent、signal，最终结果继续以 `isError` 区分 value/error，并可携带 `meta`。0.1.3 仍提供 monotonic `tools.guard()`，所以 ask-user 双层拒绝策略不变。
- Session durable format 从旧 generation 更新为 v2。`SessionEvent.seq` 变为 branded `SessionSeq`；`Session` 新增 `snapshotEvents()`、`inheritedEventCount` 和 `header.isSeeded`，fork lineage 继续由 `header.parentSession` 标识。原 `assistant/chunk` durable event 被移除；完整 timed stream 嵌入最终 `assistant/message.stream`，无 surface message 的尝试写为 `assistant/attempt`。插件删除对 `assistant/chunk` 的旧 discriminant 判断，继续无损转发新的 merge-extensible event vocabulary。
- DSH 没有单独的 durable `session/fork` log event；fork 是 `session/created` 加 `SessionHeader.parentSession`/`inheritedEventCount`。插件现在监听 `session/created`，将根 session 映射为 `session/start`，将 child 映射为 `session/fork`，并从 inherited prefix 的最后一个 `turn/end` 派生可用的 turn boundary。`session/disposed` 映射为 `session/end`。
- `Agent.inject(UserMessage)` 与 `Agent.cancel({ kind: 'user' })` 签名保持兼容。插件在实际注入/人工取消时额外镜像 `agent.inject`/`agent.cancel`，使 workbench timeline 能观察这两条控制边。
- 多 session 的原生 event seq 各自从 0 开始，不能直接作为同一 workbench adapter stream 的全局顺序。插件写出/POST 前分配单调 `sequence`，并以 `sourceSequence` 保留原 Session seq；生命周期和插件控制事件也进入同一传输顺序。

## 实现核验

- 单个 dsh step 聚合为一个 work unit，`assistant/message` 先提供 intent 和同一步 planned tool names，第一 gated call 创建 unit，后续 calls 带同一 `unitId` 走 sub-call gate。`/units` 404 会失败并进入 fail-closed，不会静默转 `/actions`。
- `tools/pre-execute` 只记录等待/批准；`tools/post-execute` 观察 post 阶段；`tools/result` 使用最终真实结果回写 tool-result，包括成功/失败、输出/错误、`meta` evidence 和可用的 external-side-effect 标记。
- `ask_user_question` 无条件 pre-execute deny，并注册不可被 listener 反向放行的 monotonic guard；工具可以因 dsh preset 仍对模型可见，但不可执行。
- 人工 cancel 依据 `byHuman` 或非 fail-closed 的人工叫停事件；超时、dsh abort 和插件主动取消不会误触发 `agent.cancel({ kind: 'user' })`。等待 promise 在 abort 时返回 deny，并尽力取消工作台卡片。
- 根 session、fork child、turn、step 和未知 session 事件均写入本地 JSONL；adapter-events 不存在时明确记录未持久化，不冒充工作台已成功。
- `link-dsh` 现在必须显式提供 `DSH_CLONE`，校验 checkout 是 `@deepseek-ai/dsh-root@0.1.3-alpha.1` 且 HEAD 精确为 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，并只在仓库本地 `node_modules/@deepseek-ai/<package>` 建单包链接。它不读取、运行、修改或修复 `~/.dsh`，也不链接外部 `node_modules` scope。

## 已运行

- 阅读新版源码与示例：`packages/core/{tools,agent,session,system-prompt}` 的 types/events，`vendor/loader`，`packages/test-support/loader-smoke`，`packages/bundle/{base,headless}`，CLI profile/plugin loader 及旧版 commit 到当前 HEAD 的 diff。
- `DSH_CLONE=/Users/sakimi/Desktop/DSH/deepseek-harness npm run link-dsh`：成功链接 264 个仓库内 package；无 `DSH_CLONE` 时安全失败并明确声明不检查 `~/.dsh`。
- `npm run typecheck`：通过。
- `npm test -- --reporter=dot`：5 files / 13 tests passed。新增真实 Loader composition、不可绕过 guard、session/fork/turn/step、inject/cancel 和多 call work-unit/result 覆盖。
- `npm run build`：通过。
- `npm run smoke`：通过。该 smoke 使用 0.1.3 的真实 Cordis Loader 与真实 Agent/SystemPrompt/Tools services 导入构建产物，确认插件应用、`declare_decision` 注册，并通过真实 `ctx.tools.execute()` 证明 ask-user body 未执行。
- `npm pack --dry-run`：通过；tarball 仅包含 README、`cordis.patch.yml`、manifest 和 `dist`，bundle patch 会随包发布。
- 主仓库 `npm run typecheck`：通过。
- 主仓库 `npm test -- --run`：13 files / 81 tests passed。
- 主仓库 `npm run build`：通过。
- 为刷新 checkout 中落后于源码的 `lib/types`，运行 `pnpm run build:lib:host`。core agent/session/tools 等目标包成功构建，但命令最终在 DSH 自身 `dsh-root` bundle 失败：`@deepseek-ai/dsh-session-persistence` 缺少 `DEFAULT_PREPARED_SESSION_CACHE_SIZE`、`DEFAULT_WRITE_BATCH_MAX_DELAY_MS`、`MAX_WRITE_BATCH_DELAY_MS`、`PersistenceCoordinator` 四个导出。这是当前 DSH checkout 的仓库级构建问题，不是本插件编译错误；DSH worktree 没有因此出现 tracked 修改。

## 未验证边界

- 未在真实 DeepSeek 模型上完成一次 CLI 到 workbench 的端到端工具调用。该路径需要可用模型凭据/网络、运行中的 workbench，以及人工处理 gate；本次只能声明 keyless 的真实 Loader/composition 与工具执行管线成功，不能声明模型端到端成功。
- DSH checkout 的全量 host build 有上述上游/checkout 内部缺失导出错误；插件的 typecheck/test/build/smoke 和所依赖 core package 构建均已独立通过。
- 工作台若没有 `/units` 或 `/adapter-events`，插件仍按设计明确 fail-closed 或记录未持久化，不会降级伪成功。
