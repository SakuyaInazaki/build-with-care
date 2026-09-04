# dsh 决策流 POC 实测报告

> 2026-09-04 晚 · 芝士。环境：沙箱 Debian 13 + Node 22.14 + pnpm 11.7，dsh 源码 master（0.1.3-alpha.1）浅克隆，`pnpm install --ignore-scripts`（fs-ext 原生模块编译跳过，不影响测试）。
> 测试代码：<poc/decision-stream-poc.spec.ts>（放入 dsh 的 `packages/core/agent-loop/tests/` 即可运行）。

## 结论：五个核心口子全部实测通过

| # | 口子 | 结果 | 验证方式 |
|---|---|---|---|
| ① | 红卡挂起：`pre-execute` 返回 pending promise 时 **agent loop 真的停住**（工具不执行、无下一次模型调用），卡片拿到完整入参 | ✅ | 自写 POC 测试，MockAdapter 扮演模型 |
| ② | deny 理由回传：翻案理由变成模型可见的 isError 结果，**下一次模型调用的上下文里含理由**，模型据此改道（剧本：sqlite 被翻案 → 改写 postgres） | ✅ | 同上 |
| ③ | `agent.inject()` 只向前：注入的在案约束**不出现在注入前的请求里，出现在下一步请求里** | ✅ | 同上 |
| ④ | `agent.cancel()` 叫停：挂起中拉闸 → 任务中止、工具从未执行、无新模型调用 | ✅ | 同上 |
| ⑤ | Slots 面板 + 审批 UI：官方 `ui-slots` 核心测试与 `ui-approval` 面板测试在本沙箱全过 | ✅ | 官方测试 42/42 |

另：官方拦截语义测试集 `interception.spec.ts` 在本沙箱 **23/23 通过**，与调研结论一致。

## 实测中踩到的坑（真插件必须照做）

1. **挂起的 gate 必须监听 `exec.signal`**：`agent.cancel()` 不会抛弃 pending promise——不自己收敛，session 永远到不了 idle。正确写法（POC 已含）：
   ```ts
   exec.signal.addEventListener('abort', () => verdict.resolve({ kind: 'deny', reason: '已被人工叫停' }), { once: true })
   ```
2. 沙箱 apt 源不可用 → 原生模块编译跳过即可；node 用官方 tarball 装。
3. **沙箱代理掐了对 api.anthropic.com 的直连**（请求发出无响应），本沙箱内测不了真模型对话；引擎级验证不受影响。黑客松现场网络无此限制，但 demo 前要在现场网络先试。

## 对计划的影响

- 机制①②③④的引擎级风险已清零，剩余风险集中在：真模型下卡片抽取质量（红蓝判定 prompt/规则）、Slots 面板与 Host 的桥接（`user-questions/request` 或自建路由）——都是 9/5 上午的活。
- POC 测试代码可直接当真插件的行为规约：写完插件跑同一组断言。
