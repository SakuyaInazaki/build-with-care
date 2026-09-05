# 后端运行时发布审计与有界修复

日期：2026-09-05，2026-09-06 补充最终边界修复与命令隔离决策。

## 范围与现场保护

本轮只核查当前默认产品链路 `frontend/` → `decision-desk/server/`；旧 `src/server.ts` 只算参考实现，不把两套能力或测试数相加。核查基线为 `docs/requirements-v1-frozen.md`、同日当前产品差距、后端统一、流式/审查恢复、工作单元、验证闭环和请求次数记录。

实现与审计阶段没有修改真实任务、模型配置或密钥，也没有新建测试文件／测试用例。源码候选提交并推送后，部署 helper 再次确认两条任务均已完成且没有活动 Grill，才替换 4322 的旧进程。部署后 bootstrap 为 `unified-work-units-v3`；任务状态、revision、持久化文件哈希和公开设置均保持不变。完整部署与只读生产 smoke 见 `2026-09-06-v3-deployment-result.md`。

## 已修复的具体问题

1. **成果文件绕过会话认证。** `/artifacts/:id/*` 原位于 `/api` 的 Host、Origin、cookie 校验之外。现在 API 和成果文件共用本地来源及进程会话校验；隔离探针确认无 cookie 为 401，有 bootstrap cookie 为 200。
2. **进程 token 没有服务端到期。** cookie 虽有 24 小时 Max-Age，服务端 token 原可存活到进程结束。现在服务端同样在 24 小时到期；到期后旧 cookie 返回 401，已建立的状态流在 token 到期时结束，下一次 bootstrap 旋转为新的随机 token。假时钟探针确认 401、token 变化及新 cookie 200。
3. **保存前没有任何脱敏且记录权限过宽。** `Store` 现在在写 state、业务事件和原始 dsh 事件前复制并处理结构化凭据字段；已配置的 worker/reviewer key 若出现在诊断文本中，以精确值替换为 `[REDACTED]`。state/events/raw/deletion-audit 文件写入时强制 0600。`.settings.json` 仍走独立 0600 持久化，不被清空，模型配置重启恢复语义不变。
4. **脱敏不改写待恢复动作。** `args`、工具 `arguments` 和参数增量属于操作材料，不做字段替换，避免 review recovery 在重启后静默执行被改成 `[REDACTED]` 的调用。当前注册工具没有 credential 参数；写入内容仍以原参数保真持久化，供证据和恢复使用。该选择只解决可识别的结构化配置/诊断泄露，不宣称识别任意源码或自然语言中的秘密，也不批量改写历史文件。
5. **命令产生的文件未进入工作单元检查。** `run_command` 现在在执行前后比较工作区文件 hash，把新增/变化路径记录在 step，并在 `end_unit` 纳入当前 revision 的 Host 检查。命令即使返回失败或因停止而取消，也可能已经产生部分文件副作用，所以这些路径同样保留并进入后续闭环，不能因错误标签而消失。删除了已有产物的命令会记录删除路径；当前检查器无法为不存在的文件生成 artifact hash，因此单元 fail-closed，必须取消并重提。隔离 mock 执行器探针确认新增 `generated.txt` 自动得到“文本可读取与哈希绑定”证据；删除 `notes.txt` 时 end_unit 失败且单元只能取消。
6. **允许写入 Markdown/文本却无法结束单元。** `.md`/`.txt` 现在进行受控的可读取、解码替代字符和当前 hash 绑定检查。检查详情明确“不验证文本语义或内容正确性”，不会冒充功能验收。
7. **已完成任务还能被 stop 改写成 stopped。** 人工 stop 现在拒绝修改 `completed`、`stopped`、`error`、`interrupted` 终态。隔离探针确认 completed 状态、干预数均不变并返回明确冲突。
8. **慢 SSE 客户端可能无限积压完整状态。** 状态流现在尊重 `res.write` 背压；阻塞时只保留最新状态，drain 后再发送，并在断连时清理 drain、heartbeat 和状态监听器。
9. **停止中的命令被错误记为普通失败。** `run_command` 返回后若发现用户停止或 AbortSignal 已取消，`tools/result` 现在把 step（以及存在时的 decision）记为 `cancelled`，提交 `tool.cancelled` 后立即返回，不增加同操作失败计数，也不再提交 `tool.finished`。安全 mock 探针同时确认取消前已经产生的 `partial.txt` 仍记录在 `artifactPaths`，避免部分副作用被隐藏。
10. **显式检查失败仍可完成 verify-only 单元。** `verify_app` 返回结构化 `passed:false` 时工具调用本身不是传输错误，旧 `end_unit` 只检查写入路径，因而空写入的检查单元会错误完成。现在每个单元最新一次显式检查必须绑定当前 revision、当前文件 hash 且所有检查项通过；已有当前通过证据会复用，不重复生成 Host 检查。隔离探针确认无效 JSON 的单元不能完成，有效 JSON 只保留一次实际检查证据。
11. **版本别名越过了工具声明的精确范围。** 运行器旧正则还接受 `node version` 与 `npm version`；前者会执行工作区名为 `version` 的文件，后者进入 npm 的版本修改命令，并非界面声明的只读查询。2026-09-06 保留现有构建方式后，允许范围收敛为界面已经声明的精确命令：`node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build`。build/test 能力不变，Host 无隔离风险也不因此消失。

## 已核实的历史问题

- `requestCount` 只作请求序号；源码没有 30 次分支。现有真实 dsh 管线回归完成 36 次模型请求。
- 执行 SSE 及其兼容 JSON fallback 不按累计响应字节截断，不带 `max_tokens`。`complete()` 的旧 3,000,000 字节保护只用于非流式辅助路径；当前设置连接测试另有明确 15 秒请求期限，不能把它描述成执行 Agent 限制。
- 执行 Agent、Grill 与审查均使用真实 SSE；执行和 Grill 没有 10 分钟/45 秒总截止。8 秒只触发 `review.slow`，不取消审查；10 分钟只用于冻结要求规定的人工 gate。
- AbortSignal 在连接、读取流、审查、工具和命令路径继续传递；截断/断流/不完整工具参数不会执行。停止后写入有最后一跳检查，命令返回后也拒绝生成成功证据。
- 审查 evidence 字符串数组会逐项换行保留；格式/网络错误进入 `review.failed` 原动作重试，不创建人的业务判断或 gate。
- `edit_file` 的读取、空 oldText、0/多匹配预校验发生在审查前，替换使用字面回调，不把本地参数错误归为审查失败。
- worker/reviewer 每个请求边界读取最新保存设置快照；已发请求不改变。模型、端点、key、推理强度在下一请求同步，历史事件保留实际请求模型。配置 key 只在相同端点或 DeepSeek 官方等价地址间保留。
- 工作单元声明、顺序 plan、路径边界、有限结构化规则下限、revision 重审、当前文件 hash 与人工证据不变绿路径存在；这仍不等于完整通用语义验证。

## 已接受的候选发布限制与冻结基线未通过项

### 任务控制的 npm 脚本可绕过命令白名单

`run_command` 允许 `npm test`、`npm run typecheck`、`npm run build`；这些命令执行任务自己写入的 `package.json` scripts。Host 只校验表面的 npm 命令，不能阻止脚本运行任意 shell、访问网络、读本机资料、写工作区外或派生无法随直接 npm 进程一起收敛的后代进程。`node version` 也会执行当前目录的 `version` 文件，`npm version` 具有版本修改语义；两者不是只读查询。

初次审计时本机有 `/usr/bin/sandbox-exec`，但只验证出 allow-default 配置可限制部分网络和外部写入；读取、进程信号、AppleEvents、IPC、Keychain/设备及完整进程树仍无充分隔离。严格读取白名单使 Node 直接以 134 退出，且没有可用于发布证明的诊断；当时没有 bwrap、firejail、nsjail 或容器运行时。本轮没有运行恶意或真实修改型 npm 脚本，也没有把部分 Seatbelt 配置冒充安全沙箱。后续曾安装但未启动的工具及取消清理情况由 2026-09-06 独立主机记录说明，不改变产品最终仍无隔离的事实。

临时收窄提案写在 `/private/tmp/kanzheban-run-command-temporary-restriction.md`，从未应用。2026-09-06 人最终明确确认：“产品隔离也取消，保留现有构建方式”。这条最新确认取代了同日稍早的“push 前完成真实隔离”要求；VM/容器安装、实现和对抗探针均已停止，源码不引入临时命令收窄或生产隔离。

最终接受的实际边界是：精确的 `node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build` 继续由 Host 对表面命令做审查后，在任务工作区直接执行；任务可控制 `package.json` scripts，因此后三项仍能启动任意 Host 子进程、联网、读取本机资料、写工作区外或留下后代进程。该风险已向人明确说明并被作为当前产品限制接受，不再单独阻止本次候选 push；但实现仍不满足冻结 E2 的完整 shell 隔离/安全边界，评测不得标为通过，也不能在文档或界面宣称“沙箱”“隔离执行”或“外部副作用已收敛”。

### 其余冻结缺口

- 当前仅注册 list/read/write/edit/verify、工作单元控制及上述不安全的部分 command，未实现“dsh 除 ask_user_question/subagent 外全部工具”；E2 不能判通过。
- `maxParallelToolCalls=1`，检查也串行，E3 的“检查可并行、写串行”未完成。
- 连续三次同工具+路径错误进入 stopped，不是冻结 E6 要求的明确阻塞求助；重复同一规则违规没有独立的立即暂停判定。
- 确定性语义规则只覆盖有限词表；通用高影响领域识别、任意约束声明一致性和完整 shell 策略未完成，I4/B2 不能判通过。
- 自动检查仍主要是 HTML/JS/CSS/JSON 语法、有限静态约束与 Markdown/文本可读取性，不验证页面交互、游戏玩法或任意业务语义。一般纠正没有通用的针对性功能验证计划，C2 不能整体判通过。
- 脱敏是有界字段/已配置 key 防护。操作参数中的源码和自然语言不能在保持精确恢复/证据的同时靠正则可靠脱敏，D1 只能记为部分加强，不能宣称任意秘密已清除。
- Workspace 对直接写入有相对路径、symlink、扩展名和 250 KB 限制，HTTP JSON 体及字段有界；按 2026-09-06 人确认保留的无隔离方式，任务控制命令仍可绕过文件数量、总大小及外部路径边界。
- 前端 `currentChecks` 可以把后续工作单元对同一路径的当前检查用于早期单元，且原 `unitChecks` 只从 write/edit 收集路径。后端已提供 command `artifactPaths`，前端需要把命令产物归到实际单元；即使完成归属修复，跨单元当前检查仍只能解释为“当前产物该项检查通过”，不能声称原单元历史产物已恢复。

## 现有验证和证据边界

- `decision-desk`: 2026-09-06 最终 engine 修复后运行 `./node_modules/.bin/vitest run --reporter=dot`，11 个现有文件、62 项通过。另定向运行现有 model-stream/model-timeout/engine/reliability 4 文件 26 项通过。需要 ephemeral loopback 的测试在允许本机网络的隔离环境运行；没有访问 4322。
- `decision-desk`: `./node_modules/.bin/tsc --noEmit` 通过；所改后端/共享文件 Prettier check 通过。
- 版本别名修复后再次运行当前后端 typecheck + 62/62，并运行参考运行时 `npm run typecheck:reference` 与 `npm run test:reference -- --reporter=dot`，13 个现有文件、82/82 通过；其中包含现有 `src/stream.test.ts` 21 项。指定差异文件的 `git diff --check` 通过。
- 现有流测试单独确认增量 reasoning、分包 UTF-8 工具参数、usage、断流/截断 fail-closed 和主动取消。首次在受限网络沙箱中运行时因 loopback 被阻断表现为 20 秒测试超时；允许 ephemeral loopback 后 3/3 在毫秒级通过，这不是产品流故障。
- ad hoc 隔离探针使用临时目录、mock executor、ephemeral port 或假时钟，确认成果认证、token 到期、字段脱敏/0600、md hash 检查、命令新增/删除产物闭环及 completed stop guard。没有新增测试文件或测试用例。
- 只读数据盘点发现两条 live 记录：一条旧任务为 completed 但没有统一工作单元，另一条在后续只读快照中也已 completed。现有记录仍不足以证明 3 次正式真实闭环，也没有逐项执行冻结 24 项评测。正式门槛必须标为 **NOT VERIFIED**；62 项后端与 14 项前端回归不能换算为 24/24。

源码候选已经提交、推送并部署到本机 4322；无隔离 Host npm 执行是人已明确接受的当前产品限制。完整工具范围、并行调度、E6、通用验证及正式 24/24 + 3/3 闭环仍未通过，所以本次结果仍是候选版本／原型发布，不能称为冻结首版最终认证。
