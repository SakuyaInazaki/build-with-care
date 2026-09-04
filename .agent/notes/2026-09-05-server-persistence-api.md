# Server/API/持久化实现记录

日期：2026-09-05

## 变动

- 新增 `src/persistence.ts`，实现按事件追加的 JSONL persistence。写入使用同步 append，保证派生内存状态与事件顺序一致；读取时逐行解析。
- `DecisionStream` 支持注入 persistence 和从事件恢复。card-created 事件保存完整 card，spec、裁决、注入约束、分支事件保存恢复所需 metadata；恢复后重新计算 cards、branches、spec、timeline 和 report。
- 恢复时发现 `pending` card 会写入取消事件并标记为 `interrupted`，不会重新创建可等待 gate。
- JSONL 完整坏行会明确抛错；末尾不完整行被忽略并通过 `recovery.ignoredTrailingBytes` 暴露。
- `LocalAgentExecutor` 增加 workspace 路径 containment 和 demo-safe 命令 allowlist，禁止 HTTP 输入直接进入 shell。
- 重写 `src/server.ts`：session manager、启动扫描恢复、显式 session 路由、cardId 裁决、timeline agent 查询、report、branches、cancel、rewind，以及统一 JSON 错误格式和 1 MiB body limit。
- 服务固定监听 `127.0.0.1`，不开放 CORS，校验 loopback Origin/Referer；静态文件使用 decode + resolve containment，拒绝 public 外路径。
- UI 改用 session API 和 DOM 节点/textContent，避免动态事件文本进入 `innerHTML`。
- 新增 `src/persistence.test.ts`、`src/server.test.ts`，覆盖恢复、半写入、坏行、契约、隔离、来源校验、路径穿越和结构化错误。

## 原因与影响

- 产品从单一内存 demo 变为单机可重启恢复；多个 session 的 card、事件和 mode 不再互相覆盖。
- mode 对 session 不可变，切换必须创建新 session，避免静默丢历史。
- 重复裁决沿用核心层幂等/冲突语义；非 pending card 的 HTTP 裁决返回 409。
- 外部副作用仍只做标记，逻辑 rewind/fork 不会撤销已发送请求、邮件或其他真实副作用。

## 限制

- 本地边界不是身份认证；若通过反向代理或非 loopback 暴露，必须补认证、CSRF/session token 和代理策略。
- JSONL 恢复拒绝完整坏行，避免静默丢数据；末尾半行仅忽略未完成字节，不自动修复文件。
- persistence 是同步文件 IO，适合单机单用户，不适合高并发多进程写入。
- dsh、异源模型和物理 workspace snapshot 仍未接入；rewind/fork 只保留逻辑事件与分支血缘。

## 验证

- `npm install`
- `npm run typecheck`
- `npm test`（21 tests）
- `npm run build`
