#!/bin/bash
# HTTPS 设置脚本
# 使用方法: ./setup-https.sh [domain]
# 例如: ./setup-https.sh api.yourdomain.com

set -e

if [ -z "$1" ]; then
  echo "错误: 未指定域名"
  echo "使用方法: ./setup-https.sh [domain]"
  echo "例如: ./setup-https.sh api.yourdomain.com"
  exit 1
fi

DOMAIN=$1
SERVER_IP="43.247.134.242"

echo "🔒 开始配置 HTTPS for $DOMAIN..."

# 连接到服务器并执行配置
ssh -A -t "$SERVER_IP" << EOF
  set -e
  
  echo "📦 安装 Nginx..."
  if ! command -v nginx &> /dev/null; then
    sudo apt update
    sudo apt install nginx -y
    sudo systemctl start nginx
    sudo systemctl enable nginx
    echo "✅ Nginx 安装完成"
  else
    echo "✅ Nginx 已安装"
  fi
  
  echo "📦 安装 Certbot..."
  if ! command -v certbot &> /dev/null; then
    sudo apt install certbot python3-certbot-nginx -y
    echo "✅ Certbot 安装完成"
  else
    echo "✅ Certbot 已安装"
  fi
  
  echo "📝 配置 Nginx..."
  sudo tee /etc/nginx/sites-available/aave-api > /dev/null << NGINX_EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
NGINX_EOF
  
  # 启用配置
  if [ ! -L /etc/nginx/sites-enabled/aave-api ]; then
    sudo ln -s /etc/nginx/sites-available/aave-api /etc/nginx/sites-enabled/
  fi
  
  # 测试配置
  sudo nginx -t
  
  # 重载 Nginx
  sudo systemctl reload nginx
  echo "✅ Nginx 配置完成"
  
  echo "🔐 获取 SSL 证书..."
  echo "⚠️  请确保域名 $DOMAIN 的 DNS A 记录已指向 $SERVER_IP"
  echo "⚠️  按 Enter 继续，或 Ctrl+C 取消..."
  read
  
  # 获取 SSL 证书
  sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN || {
    echo "❌ SSL 证书获取失败"
    echo "请检查："
    echo "1. 域名 DNS A 记录是否指向 $SERVER_IP"
    echo "2. 80 端口是否开放"
    echo "3. 域名是否可以访问"
    exit 1
  }
  
  echo "✅ SSL 证书获取成功"
  
  # 配置自动续期
  echo "📅 配置自动续期..."
  sudo systemctl enable certbot.timer
  sudo systemctl start certbot.timer
  
  # 开放 443 端口
  echo "🔥 配置防火墙..."
  if command -v ufw &> /dev/null; then
    sudo ufw allow 443/tcp
    echo "✅ 443 端口已开放"
  elif command -v firewall-cmd &> /dev/null; then
    sudo firewall-cmd --permanent --add-port=443/tcp
    sudo firewall-cmd --reload
    echo "✅ 443 端口已开放"
  else
    echo "⚠️  未找到防火墙管理工具，请手动开放 443 端口"
  fi
  
  echo ""
  echo "=========================================="
  echo "✅ HTTPS 配置完成！"
  echo "=========================================="
  echo "HTTPS URL: https://$DOMAIN"
  echo "健康检查: https://$DOMAIN/health"
  echo "API 端点: https://$DOMAIN/api/markets"
  echo ""
  echo "请更新前端环境变量："
  echo "VITE_API_URL=https://$DOMAIN/api"
  echo ""
EOF

echo ""
echo "🎉 HTTPS 配置完成！"
echo "请访问: https://$DOMAIN/health 验证"

