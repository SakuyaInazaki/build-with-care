# v3 候选版本部署结果

日期：2026-09-06。

源码提交 `8805d95bae4fe7c4737dec1558056a5607b525ac` 已推送到 `origin/feat/decision-stream-complete`，并在远端确认分支 HEAD 与本地提交一致。

部署 helper 在发送停止信号前重新核对：旧服务仍为 `unified-work-units-v1`，监听进程及工作目录符合预期；两条任务均为 completed，revision 均为 3，没有 ready/running/waiting/stopping 任务，也没有活动 Grill。第一次 helper 调用因工作目录断言写得过严而在停止信号前退出，旧服务没有变化；按实际只读结果修正断言后再次执行并完成部署。

部署后的事实：

- 4322 bootstrap 返回 `unified-work-units-v3`；
- 两条任务仍为 completed、revision 仍为 3；
- 部署前后任务 state 与持久化文件哈希逐项一致；
- 部署前后公开设置逐项一致，没有输出或修改 API key；
- 没有自动 resume、verify、verdict、addition 或 Grill 操作，没有改变剩余 8 张缺少针对性语义验证的卡。

独立 disposable Chrome 对实际服务执行只读 smoke：欢迎页和根路由均为 200；HttpOnly、SameSite=Strict session cookie 存在；已有 HTML 成果 iframe 同源响应为 200、文档完成加载且脚本存在；认证后的直接成果读取为 200，全新无 cookie context 为 401；源码视图内容与直接读取一致；页面错误、console error、失败请求均为 0。

这次部署是已接受的候选版本／原型更新，不是冻结首版正式认证。正式 24/24、三次真实闭环、通用语义验证、完整工具范围、并行检查和其他审计中列出的缺口仍按原记录保留。
