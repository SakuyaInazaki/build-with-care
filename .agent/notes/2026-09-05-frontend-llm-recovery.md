# Frontend / LLM recovery

日期：2026-09-05

## 改动

- `src/llm/client.ts` 的 `extractJson` 改为扫描平衡的对象/数组边界，并在扫描时识别 JSON 字符串和转义字符。模型说明文字、代码围栏以及字符串中的 `}` / `]` 不再破坏候选 JSON 的边界。
- `src/llm/spec-draft.ts` 将 `MAX_CONSTRAINT_LENGTH` 统一为 24，与系统提示和产品文档一致。规范化仍然逐项继续收集，因此超长项不会阻止后面的有效约束进入结果。
- `src/llm/agent-runner.ts` 将系统提示中的“人刚刚补充了约束”改成非注入标记的描述。实际注入仍由裁决完成后的下一轮 `injectNewConstraints()` 追加，避免测试和模型把系统规则误判为已发生的注入。
- `src/llm/agent-runner.test.ts` 对齐当前判官契约：`specified_by_human` 记录来源，但不把一个未违反约束的写动作强制降为 gray；该动作仍可作为 blue 自主方案被观察和翻案。
- 新增 `src/public/app.js`：连接会话、spec 草稿/确认、demo/真实运行、SSE、断线轮询、会话状态、逐卡裁决、取消/结束、时间线回放、分支和报告模块。
- `src/public/styles.css` 为窄屏顶部操作区增加横向滚动和 560px 以下的分行布局，保留按钮最小触控尺寸；现有 focus-visible 样式继续覆盖动态控件。
- 前端渲染沿用 `dom.js` 的 `createElement` / `textContent` 路径，动态模型、事件和错误文本不经过 `innerHTML`。

## 原因与影响

这些改动修复了 LLM 测试契约，并使页面从静态 HTML 变成可操作的 API 客户端。SSE 首次连接会接收完整 state；断线或浏览器不支持 EventSource 时切换到 state 轮询。轮询只在 SSE 错误后启动，避免重复请求。

重复提交通过按钮禁用和当前卡片 busy 状态抑制；API/network 错误以可关闭 toast 呈现。菜单、表单、裁决按钮和时间线控制均为原生按钮/表单控件，支持键盘操作。

## 限制

- 真实模型运行按钮只在 `/api/config` 报告 agent 已配置时启用；后端仍是最终权限和状态校验方。
- 页面依赖现代浏览器的 `EventSource`、`dialog` 和 `closest`；没有 EventSource 时会自动使用轮询，旧浏览器的 dialog 仅退化为带 `open` 属性的容器。
- 本次没有修改 `stream`、`judge`、`server`、`types`、`work-unit` 或 DSH plugin。当前仓库的全局 typecheck 仍被范围外 `src/llm/units.ts:208` 的既有类型错误阻塞。

## 验证

- `npm test -- --run src/llm`：范围内 LLM 测试通过。
- `npm run typecheck`：未通过，唯一错误来自范围外 `src/llm/units.ts:208`；本次范围内文件没有新增 TypeScript 错误。
- 前端入口通过 `npm run build` 的静态复制配置进入 `dist/public/app.js`；运行时 API 路由使用现有 `/api/*` 合约。
