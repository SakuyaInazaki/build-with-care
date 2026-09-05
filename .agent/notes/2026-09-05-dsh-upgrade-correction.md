# dsh 升级纠正记录

日期：2026-09-05

## 为什么纠正

本轮检查发现，`docs/requirements-alignment-Y.md` 的 D5-R 被另一 agent 将已拍板的 dsh 目标版本误改成 `0.1.2-alpha.2` / `0a53fb55be`，`docs/research-dsh-Y.md` 也据此写入了“本机只有 0.1.2”的错误结论。该结论与当前真实 dsh checkout、插件 manifest、映射常量和 smoke 验证不符。纠正只恢复已拍板事实，没有新增产品偏向，也没有重写其他需求或调研事实。

## 更新过程

- 以 `/Users/sakimi/Desktop/DSH/deepseek-harness` 作为唯一显式 checkout，重新核对根 package、CLI 和核心 packages 的版本。
- 核对 HEAD 为完整 commit `d347e703908d0406b7a7ef80e3a0e594d86b2215`，短 commit 为 `d347e70390`，对应 `0.1.3-alpha.1`。
- 使用 `DSH_CLONE=/Users/sakimi/Desktop/DSH/deepseek-harness npm run link-dsh`；linker 校验精确版本和 commit，只把单个源码 package 链接到插件自己的 `node_modules`，不读取、修改或修复 `~/.dsh`。
- 保留工作区中未跟踪的 skills；本次没有删除、移动或覆盖 skills，也没有提交 commit。

## 文档修正

- `docs/requirements-alignment-Y.md` D5-R 恢复为 `0.1.3-alpha.1` / `d347e70390`，保留原有 dsh 插件路线和其余决策文字。
- `docs/research-dsh-Y.md` 改为“原调研版本为 0.1.3-alpha.1，当前已在 d347e70390 真实复核”，并移除“本机只有 0.1.2”及其派生的未验证结论；其余调研事实不变。
- 插件 README 与 `integrations/dsh-plugin/package.json` 的目标版本、commit 和链接方式保持一致；插件相关 note 的旧版本仅作为迁移背景，不再作为当前目标或验证结论。
- `README.md` 的能力矩阵改为区分“主仓库尚未安装真实 runtime”和“插件已对真实 checkout 完成复核”。
- `docs/api-contract-v2.md` 与 `docs/work-unit-design.md` 明确是三份平权 requirements 上的实现契约；没有声称覆盖或废止 S 的 recorder 非阻断要求。recorder 的 drift 对账与 policy safety net 的约束阻断分开说明。

## 对插件的影响

插件当前目标为 `0.1.3-alpha.1` / `d347e70390`。0.1.3 的真实 composition 使用 bundle patch，插件将 dsh step 聚合为 work unit，通过 `/units` 接收 admission，以 `tools/post-execute` / `tools/result` 回写最终外部执行结果，并镜像 inject、cancel 和 session/turn/step 事件。`ask_user_question` 仍由 pre-execute 与 monotonic guard 双重拒绝。README、manifest、mapping、linker 和 smoke 均使用同一目标版本与 commit。

## 验证结果

- 插件 `npm run link-dsh`：通过，成功链接 264 个 dsh package。
- 插件 `npm run typecheck`：通过。
- 插件 `npm test -- --reporter=dot`：通过，5 files / 13 tests。
- 插件 `npm run build`：通过。
- 插件 `npm run smoke`：通过，使用真实 0.1.3-alpha.1 Cordis Loader composition，并确认 `ask_user_question` body 未执行。
- 插件 `npm pack --dry-run`：通过，包内容包含 README、patch、manifest 和 dist。
- 主仓库此前验收的 `npm run typecheck`、`npm test`、`npm run build` 均通过；本次文档修正后另行执行 `git diff --check`。

## 边界

本轮没有在真实 DeepSeek 模型、真实凭据和网络条件下完成从 CLI 到 workbench 的模型 E2E。已验证的是锁定 checkout 上的真实 Loader/composition、插件测试、smoke 和工具执行管线；不能据此声称真实模型端到端运行成功。dsh checkout 的全量 host bundle build 仍有既有缺失导出问题，不影响插件自身上述验证。
