# 公开演示站部署手册

目标：评委打开一个链接就能用，不装任何东西。

当前目标机：阿里云轻量应用服务器，Ubuntu 24.04，2 vCPU / 2 GiB，公网 `101.201.125.231`。

## 结构

整站是一个 Docker 镜像：前端构建产物 + `decision-desk` 后端 + 行为验证用的 Chromium。宿主机只需要 Docker。

## 一、服务器准备（只做一次）

```sh
scp deploy/server-bootstrap.sh root@101.201.125.231:/tmp/
ssh root@101.201.125.231 'bash /tmp/server-bootstrap.sh'
```

脚本做四件事：

1. **加 2 GB swap**。2 GiB 内存跑 vite 构建 + Chromium 会贴顶，没有 swap 构建会被 OOM 杀掉。
2. **装 Docker**，apt 源走阿里云镜像（直连 `download.docker.com` 在国内常年超时）。
3. **配镜像加速器**，否则 Docker Hub 基本拉不动。
4. 系统防火墙放行端口。

**还有一步必须在网页控制台做**：轻量应用服务器 → 防火墙 → 添加规则 → TCP `8080` → 放行。阿里云轻量的防火墙在控制台，不在系统里；不加这条规则外网访问不到。

## 二、部署

```sh
cp .env.deploy.example .env.deploy   # 填 PUBLIC_HOST / PUBLIC_PORT
./deploy/deploy.sh root@101.201.125.231
```

`deploy.sh` 把源码 rsync 到 `/opt/kanzheban`，在远端 `docker compose up -d --build`。首次构建要装依赖和 Chromium，大约 5–10 分钟。

## 三、`PUBLIC_HOST` 必须填对

后端只接受白名单内的 Host 调用 `/api`，这是本地部署时防止跨站访问的护栏。`PUBLIC_HOST` 要和评委浏览器地址栏里的内容**完全一致**，包括端口：

- 用 IP + 端口访问 → `101.201.125.231:8080`
- 以后绑了域名 → `demo.example.com`

填错的表现是页面能打开、但所有接口返回 `{"error":"只允许本地访问"}`。

## 四、只读展示站

`PUBLIC_DEMO=1` 时（默认），站点**只接受 GET**，任何写操作一律 403。

这不是逐条设防的结果，而是一个判断：单实例、匿名访问的部署里，没有一种写操作是安全的——模型密钥全服务器共享、真实模式下 `run_command` 会在宿主机执行任务自带的脚本、记录也是所有访客共用的。与其把这些入口一个个堵上，不如只开放读。

访客能做的：翻看真实跑出来的会话记录——每一张决策卡、双栏对账、时间线回放、结束报告、以及 agent 实际做出来的成品页面。
访客不能做的：创建任务、配置模型、修改或删除任何记录。前端通过 `/api/bootstrap` 返回的 `read-only-v1` 能力位隐藏创建入口与模型设置，界面上不会出现点了没反应的按钮。

**预置展示记录**由 `PUBLIC_DEMO_PINNED`（逗号分隔的 run ID）指定，永不被后台清理。当前钉住的是一次真实的「网页版超级马里奥」会话：111 步、17 张决策卡、10 次人的干预、8 次纠正。

其余记录按 `PUBLIC_DEMO_KEEP`（默认 40 条）和 `PUBLIC_DEMO_MAX_AGE_HOURS`（默认 12 小时）定期清理。

### 灌入一份展示记录

```sh
tar czf /tmp/run.tgz -C frontend/.data/runs <run-id>
scp /tmp/run.tgz root@主机:/tmp/
ssh root@主机 'mkdir -p /tmp/seed && tar xzf /tmp/run.tgz -C /tmp/seed \
  && docker cp /tmp/seed/<run-id> kanzheban:/data/runs/ \
  && docker exec -u root kanzheban chown -R node:node /data/runs \
  && docker compose -f /opt/kanzheban/docker-compose.yml --env-file /opt/kanzheban/.env restart'
```

记录在服务启动时加载，所以灌完必须重启容器。别忘了把 run ID 加进 `.env.deploy` 的 `PUBLIC_DEMO_PINNED`，否则下一轮清理会把它扫掉（这是实测踩过的）。

## 五、日常操作

```sh
ssh root@101.201.125.231 'cd /opt/kanzheban && docker compose logs -f --tail=100'   # 看日志
ssh root@101.201.125.231 'cd /opt/kanzheban && docker compose restart'              # 重启
ssh root@101.201.125.231 'cd /opt/kanzheban && docker compose down'                 # 停站
```

会话数据在名为 `kanzheban-data` 的 Docker volume 里，`down` 不会删；要清空用 `docker compose down -v`。

## 六、没备案的注意事项

大陆服务器未备案域名时避开 80/443，用 8080 这类端口。绑域名前先在阿里云完成 ICP 备案，否则域名解析过来会被拦。
