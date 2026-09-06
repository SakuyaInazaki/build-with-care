#!/usr/bin/env bash
# 在服务器上执行一次：装 Docker、加交换分区、放行端口。
# 目标环境：阿里云轻量应用服务器 Ubuntu 24.04，2 核 2G。
set -euo pipefail

PORT="${PUBLIC_PORT:-8080}"

echo "== 1/4 交换分区 =="
# 2G 内存构建前端 + 跑 Chromium 会贴顶，先备 2G swap，避免构建被 OOM 杀掉。
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  echo "已启用 2G swap"
else
  echo "swap 已存在，跳过"
fi

echo "== 2/4 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  # 国内直连 download.docker.com 常常超时，走阿里云镜像。
  curl -fsSL https://mirrors.aliyun.com/docker-ce/linux/ubuntu/gpg |
    gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://mirrors.aliyun.com/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker 已安装：$(docker --version)"
fi

echo "== 3/4 镜像加速 =="
# Docker Hub 在大陆直连基本拉不动，配置公共镜像加速器。
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat >/etc/docker/daemon.json <<'JSON'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.net",
    "https://mirror.ccs.tencentyun.com"
  ],
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
  echo "已写入镜像加速器"
else
  echo "/etc/docker/daemon.json 已存在，未覆盖；如果拉镜像很慢请自行加 registry-mirrors"
fi
systemctl enable --now docker

echo "== 4/4 端口 =="
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow "${PORT}"/tcp || true
fi
cat <<TIP

系统侧准备完成。还差一步在网页控制台做：
  轻量应用服务器 → 防火墙 → 添加规则 → TCP ${PORT} → 放行
（阿里云轻量的防火墙在控制台，不在系统里；不加这条规则外网访问不到。）
TIP
