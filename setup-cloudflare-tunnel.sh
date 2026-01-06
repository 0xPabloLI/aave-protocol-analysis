#!/bin/bash

# Cloudflare Tunnel 自动安装和配置脚本
# 使用方法: ./setup-cloudflare-tunnel.sh [服务器IP]

set -e

TARGET_HOST=$1

if [ -z "$TARGET_HOST" ]; then
  echo "错误: 未指定服务器地址"
  echo "用法: ./setup-cloudflare-tunnel.sh [服务器IP或域名]"
  exit 1
fi

echo "🚀 开始配置 Cloudflare Tunnel 到 $TARGET_HOST..."

# 连接到服务器并执行安装
ssh -A -t "$TARGET_HOST" << 'EOF'
set -e

echo "=========================================="
echo "步骤 1: 安装 cloudflared"
echo "=========================================="

# 检查是否已安装
if command -v cloudflared &> /dev/null; then
  echo "✅ cloudflared 已安装"
  cloudflared --version
else
  echo "📦 正在安装 cloudflared..."
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb || sudo apt-get install -f -y
  rm /tmp/cloudflared.deb
  echo "✅ cloudflared 安装完成"
  cloudflared --version
fi

echo ""
echo "=========================================="
echo "步骤 2: 登录 Cloudflare"
echo "=========================================="
echo "⚠️  请按照以下步骤操作："
echo "1. 下面的命令会打开浏览器"
echo "2. 登录你的 Cloudflare 账户"
echo "3. 选择域名 aaveapy.com"
echo "4. 授权后会自动下载证书"
echo ""
echo "按 Enter 继续，或 Ctrl+C 取消..."
read

# 登录 Cloudflare（会打开浏览器）
cloudflared tunnel login

echo ""
echo "=========================================="
echo "步骤 3: 创建隧道"
echo "=========================================="

# 检查隧道是否已存在
TUNNEL_NAME="aave-api-tunnel"
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
  echo "✅ 隧道 $TUNNEL_NAME 已存在"
  TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
  echo "Tunnel ID: $TUNNEL_ID"
else
  echo "📝 创建新隧道: $TUNNEL_NAME"
  TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME")
  TUNNEL_ID=$(echo "$TUNNEL_OUTPUT" | grep -oP 'Created tunnel \K[^\s]+' || cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
  echo "✅ 隧道创建成功"
  echo "Tunnel ID: $TUNNEL_ID"
fi

echo ""
echo "=========================================="
echo "步骤 4: 配置隧道"
echo "=========================================="

# 创建配置目录
sudo mkdir -p /etc/cloudflared

# 获取证书文件路径
CERT_FILE=$(ls ~/.cloudflared/*.json 2>/dev/null | head -1)
if [ -z "$CERT_FILE" ]; then
  echo "❌ 错误: 未找到 Cloudflare 证书文件"
  echo "请先运行: cloudflared tunnel login"
  exit 1
fi

# 创建配置文件
echo "📝 创建配置文件..."
sudo tee /etc/cloudflared/config.yml > /dev/null <<CONFIG
tunnel: $TUNNEL_ID
credentials-file: $CERT_FILE

ingress:
  # API 子域名路由到本地 3001 端口
  - hostname: api.aaveapy.com
    service: http://localhost:3001
  # 默认规则（必须放在最后）
  - service: http_status:404
CONFIG

echo "✅ 配置文件已创建: /etc/cloudflared/config.yml"

# 验证配置
echo "🔍 验证配置..."
sudo cloudflared tunnel validate || echo "⚠️  配置验证失败，但继续..."

echo ""
echo "=========================================="
echo "步骤 5: 配置 DNS 路由"
echo "=========================================="

echo "📝 配置 DNS 路由..."
cloudflared tunnel route dns "$TUNNEL_NAME" api.aaveapy.com || {
  echo "⚠️  DNS 路由配置失败，请手动配置："
  echo "   在 Cloudflare Dashboard 中："
  echo "   1. 进入 DNS → Records"
  echo "   2. 编辑 api 记录"
  echo "   3. 类型改为 CNAME"
  echo "   4. 内容改为: $TUNNEL_ID.cfargotunnel.com"
  echo "   5. Proxy 状态: Proxied (橙色云朵)"
}

echo ""
echo "=========================================="
echo "步骤 6: 安装为系统服务"
echo "=========================================="

# 安装为系统服务
if systemctl is-active --quiet cloudflared; then
  echo "✅ cloudflared 服务已在运行"
else
  echo "📦 安装 cloudflared 系统服务..."
  sudo cloudflared service install || {
    echo "⚠️  服务安装失败，尝试手动安装..."
    echo "运行: sudo cloudflared service install"
  }
  
  echo "🚀 启动服务..."
  sudo systemctl start cloudflared || echo "⚠️  启动失败"
  sudo systemctl enable cloudflared || echo "⚠️  设置自启失败"
fi

# 等待服务启动
sleep 2

# 检查服务状态
if systemctl is-active --quiet cloudflared; then
  echo "✅ cloudflared 服务运行正常"
  sudo systemctl status cloudflared --no-pager -l | head -10
else
  echo "❌ cloudflared 服务未运行"
  echo "查看日志: sudo journalctl -u cloudflared -f"
fi

echo ""
echo "=========================================="
echo "步骤 7: 更新后端端口配置（改回 3001）"
echo "=========================================="

# 检查 ecosystem.config.cjs 是否存在
if [ -f "/root/aave/ecosystem.config.cjs" ]; then
  echo "📝 更新 PM2 配置，将端口改回 3001..."
  cd /root/aave
  
  # 备份
  cp ecosystem.config.cjs ecosystem.config.cjs.backup
  
  # 更新端口（使用 sed）
  sed -i 's/PORT: 80/PORT: 3001/' ecosystem.config.cjs
  
  echo "✅ 配置已更新"
  echo "需要重新部署后端以应用更改"
else
  echo "⚠️  未找到 ecosystem.config.cjs，请手动更新端口为 3001"
fi

echo ""
echo "=========================================="
echo "步骤 8: 关闭 80/443 端口（可选）"
echo "=========================================="

echo "是否要关闭防火墙中的 80/443 端口？(y/n)"
read -r CLOSE_PORTS

if [ "$CLOSE_PORTS" = "y" ] || [ "$CLOSE_PORTS" = "Y" ]; then
  if command -v ufw &> /dev/null; then
    echo "🔒 关闭 UFW 中的 80/443 端口..."
    sudo ufw delete allow 80/tcp 2>/dev/null || echo "80 端口规则不存在或已删除"
    sudo ufw delete allow 443/tcp 2>/dev/null || echo "443 端口规则不存在或已删除"
    echo "✅ 端口已关闭"
  elif command -v firewall-cmd &> /dev/null; then
    echo "🔒 关闭 firewalld 中的 80/443 端口..."
    sudo firewall-cmd --permanent --remove-port=80/tcp 2>/dev/null || true
    sudo firewall-cmd --permanent --remove-port=443/tcp 2>/dev/null || true
    sudo firewall-cmd --reload
    echo "✅ 端口已关闭"
  else
    echo "⚠️  未找到防火墙管理工具，请手动关闭 80/443 端口"
  fi
else
  echo "⏭️  跳过端口关闭"
fi

echo ""
echo "=========================================="
echo "✅ Cloudflare Tunnel 配置完成！"
echo "=========================================="
echo ""
echo "📋 配置摘要:"
echo "  - 隧道名称: $TUNNEL_NAME"
echo "  - 隧道 ID: $TUNNEL_ID"
echo "  - 后端端口: 3001 (更安全)"
echo "  - 公网端口: 无需开放"
echo ""
echo "🔍 验证步骤:"
echo "  1. 等待 1-2 分钟让 DNS 生效"
echo "  2. 测试: curl https://api.aaveapy.com/health"
echo ""
echo "📝 管理命令:"
echo "  - 查看状态: sudo systemctl status cloudflared"
echo "  - 查看日志: sudo journalctl -u cloudflared -f"
echo "  - 重启服务: sudo systemctl restart cloudflared"
echo ""
echo "⚠️  重要: 如果 DNS 路由配置失败，请手动在 Cloudflare Dashboard 中配置"
echo "   DNS 记录: api.aaveapy.com → CNAME → $TUNNEL_ID.cfargotunnel.com (Proxied)"
echo ""
EOF

echo ""
echo "✅ 脚本执行完成！"
echo ""
echo "下一步:"
echo "1. 如果 DNS 路由未自动配置，请在 Cloudflare Dashboard 中手动配置"
echo "2. 等待几分钟让 DNS 生效"
echo "3. 测试: curl https://api.aaveapy.com/health"
echo "4. 重新部署后端（端口已改回 3001）: ./deploy.sh $TARGET_HOST"

