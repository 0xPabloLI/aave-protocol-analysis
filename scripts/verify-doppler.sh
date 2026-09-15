#!/bin/bash
# 验证 Doppler 是否正常工作并成功拉取环境变量
# 使用方法：在服务器上运行 ./scripts/verify-doppler.sh

set -e

echo "=========================================="
echo "Doppler 环境变量验证脚本"
echo "=========================================="
echo ""

# 1. 检查 Doppler CLI 是否安装
echo "1. 检查 Doppler CLI 安装状态..."
if command -v doppler &> /dev/null; then
  DOPPLER_VERSION=$(doppler --version 2>/dev/null || echo "unknown")
  echo "   ✅ Doppler CLI 已安装 (版本: $DOPPLER_VERSION)"
else
  echo "   ❌ Doppler CLI 未安装"
  echo "   💡 安装方法: curl -Ls https://cli.doppler.com/install.sh | sh"
  exit 1
fi
echo ""

# 2. 检查 DOPPLER_TOKEN 是否设置
echo "2. 检查 DOPPLER_TOKEN 环境变量..."
if [ -z "$DOPPLER_TOKEN" ]; then
  echo "   ❌ DOPPLER_TOKEN 未设置"
  echo "   💡 设置方法："
  echo "      - 在本地 .env 文件中添加 DOPPLER_TOKEN=xxx（deploy.sh 会自动传递）"
  echo "      - 或在服务器上设置: export DOPPLER_TOKEN='your-token-here'"
  echo "      - 或添加到 ~/.bashrc: export DOPPLER_TOKEN='your-token-here'"
  exit 1
else
  # 只显示 token 的前几个字符，不显示完整 token
  TOKEN_PREFIX=$(echo "$DOPPLER_TOKEN" | cut -c1-10)
  echo "   ✅ DOPPLER_TOKEN 已设置 (前缀: ${TOKEN_PREFIX}...)"
fi
echo ""

# 3. 尝试从 Doppler 拉取环境变量
echo "3. 尝试从 Doppler 拉取环境变量..."
if doppler secrets download --no-file --format env > /dev/null 2>&1; then
  echo "   ✅ Doppler 连接成功"
  
  # 获取环境变量列表
  ENV_VARS=$(doppler secrets download --no-file --format env 2>/dev/null)
  
  if [ -z "$ENV_VARS" ]; then
    echo "   ⚠️  Doppler 返回了空的环境变量列表"
    echo "   💡 请检查 Doppler 项目配置，确保已添加必要的 secrets"
  else
    # 统计环境变量数量
    VAR_COUNT=$(echo "$ENV_VARS" | grep -c '=' || echo "0")
    echo "   ✅ 成功拉取了 $VAR_COUNT 个环境变量"
    
    # 列出所有环境变量键（不显示值）
    echo ""
    echo "   环境变量列表："
    echo "$ENV_VARS" | grep '=' | cut -d'=' -f1 | while read -r key; do
      if [ -n "$key" ]; then
        echo "      - $key"
      fi
    done
    
    # 检查关键环境变量
    echo ""
    echo "   关键环境变量检查："
    CRITICAL_VARS=("CLOUDFLARE_WORKER_URL")
    for var in "${CRITICAL_VARS[@]}"; do
      if echo "$ENV_VARS" | grep -q "^${var}="; then
        echo "      ✅ $var 已设置"
      else
        echo "      ❌ $var 未设置"
      fi
    done
  fi
else
  echo "   ❌ Doppler 连接失败"
  echo "   💡 可能的原因："
  echo "      - DOPPLER_TOKEN 无效或已过期"
  echo "      - 网络连接问题"
  echo "      - Doppler 项目配置错误"
  exit 1
fi
echo ""

# 4. 检查 PM2 进程中的环境变量
echo "4. 检查 PM2 进程环境变量..."
if command -v pm2 &> /dev/null; then
  if pm2 list | grep -q "aave-backend"; then
    echo "   ✅ aave-backend 进程正在运行"
    
    # 检查 PM2 进程是否有 DOPPLER_TOKEN
    PM2_DOPPLER_TOKEN=$(pm2 describe aave-backend 2>/dev/null | grep -oP 'DOPPLER_TOKEN[^=]*=\K[^\s]*' || echo "")
    if [ -n "$PM2_DOPPLER_TOKEN" ]; then
      TOKEN_PREFIX=$(echo "$PM2_DOPPLER_TOKEN" | cut -c1-10)
      echo "   ✅ PM2 进程中有 DOPPLER_TOKEN (前缀: ${TOKEN_PREFIX}...)"
    else
      echo "   ⚠️  PM2 进程中没有 DOPPLER_TOKEN"
      echo "   💡 解决方法："
      echo "      - 运行: pm2 reload ecosystem.config.cjs --only aave-backend --update-env"
      echo "      - 或重启 PM2: pm2 restart aave-backend --update-env"
    fi
    
    # 检查 PM2 进程是否有 CLOUDFLARE_WORKER_URL
    PM2_WORKER_URL=$(pm2 describe aave-backend 2>/dev/null | grep -oP 'CLOUDFLARE_WORKER_URL[^=]*=\K[^\s]*' || echo "")
    if [ -n "$PM2_WORKER_URL" ]; then
      echo "   ✅ PM2 进程中有 CLOUDFLARE_WORKER_URL"
    else
      echo "   ❌ PM2 进程中没有 CLOUDFLARE_WORKER_URL"
      echo "   💡 这可能是导致警告的原因"
    fi
  else
    echo "   ℹ️  aave-backend 进程未运行"
  fi
else
  echo "   ℹ️  PM2 未安装或不在 PATH 中"
fi
echo ""

# 5. 总结
echo "=========================================="
echo "验证完成"
echo "=========================================="
echo ""
echo "💡 提示："
echo "   - 如果看到 'CLOUDFLARE_WORKER_URL not set' 警告，请确保："
echo "     1. 在 Doppler 中已添加 CLOUDFLARE_WORKER_URL secret"
echo "     2. PM2 进程已重启以加载新环境变量: pm2 reload ecosystem.config.cjs --only aave-backend --update-env"
echo "   - 查看应用日志: pm2 logs aave-backend"
echo "   - 查看应用启动时的环境变量加载日志: pm2 logs aave-backend --lines 50"
echo ""
