# 产品隔离取消与主机准备记录

日期：2026-09-06。

人最终明确确认：“产品隔离也取消，保留现有构建方式”。这条确认取代了同日稍早“push 前完成真实隔离”的要求。产品源码没有新增容器、VM、Seatbelt 或命令收窄实现；`run_command` 继续保留 `node --version`、`npm --version`、`npm test`、`npm run typecheck`、`npm run build`，其中 npm lifecycle scripts 直接在 Host 的任务工作区执行。该边界的具体风险与未通过的冻结 E2 项见 `2026-09-05-backend-runtime-release-audit.md`。

在取消前只进行了以下主机准备，不属于仓库依赖或产品能力：

- 核查到本机为 Apple silicon、macOS 26.2；当时没有可用的 Docker、Podman、Colima、Lima、OrbStack 或 Apple `container` CLI，只有系统 `/usr/bin/sandbox-exec`。
- 下载 Apple `container` 1.3.1 signed installer 到 `/private/tmp/container-1.3.1-installer-signed.pkg`。文件 SHA-256 与 Apple GitHub release 公布值一致，但本机 `pkgutil --check-signature` 返回 invalid signature，Gatekeeper 返回 Code Signing subsystem error，因此没有安装或运行该包。
- 通过 Homebrew 安装了主机工具 `colima 0.10.3`、`lima 2.2.0`、`docker` CLI `29.8.0`。没有接受 Docker Desktop 商业条款，也没有安装 Docker Desktop。
- 曾启动唯一的任务专用命令 `colima start kanzheban ...`，要求无 Host mount、无端口转发且不切换活动 Docker context；人在下载 VM 磁盘期间取消隔离方向后，只对该命令的精确 PID 发送 TERM。随后 `colima list` 与 `limactl list` 均为空，没有 VM、容器或镜像存在或运行；活动 Docker context 仍为取消前已有的 `orbstack`。
- 留有未运行的 Host 配置 `~/.colima/kanzheban/colima.yaml` 和上述 `/private/tmp` 安装包。本轮没有卸载或删除既有／已安装主机资源，也没有触碰 4322 服务、真实任务、模型设置或密钥。

本记录只说明已停止的主机准备与最终产品边界。当前工作树是发布候选补丁，仍不是冻结首版最终认证；不得把取消的隔离方案、已安装 CLI 或未创建的 VM 写成已交付能力。
