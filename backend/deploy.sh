#!/bin/bash

# Aave Backend 部署脚本
# 使用方法: ./deploy.sh [pm2|local]

set -e

DEPLOY_METHOD=${1:-pm2}

echo "🚀 开始部署 Aave Backend..."
echo "📦 部署方式: $DEPLOY_METHOD"

# 检查 Node.js 是否安装
if ! command -v node &> /dev/null; then
    echo "❌ Node.js 未安装，请先安装 Node.js"
    exit 1
fi

# 进入后端目录
cd "$(dirname "$0")"
BACKEND_DIR=$(pwd)
ROOT_DIR=$(cd .. && pwd)

echo "📁 后端目录: $BACKEND_DIR"
echo "📁 根目录: $ROOT_DIR"

# 安装根目录依赖（数据获取脚本）
echo "📦 安装根目录依赖..."
cd "$ROOT_DIR"
if [ ! -d "node_modules" ]; then
    npm install
fi

# 构建根目录代码（数据获取脚本）
echo "🔨 构建根目录代码..."
npm run build

# 首次运行数据获取脚本（生成初始数据）
echo "📊 获取初始数据..."
if [ ! -d "data" ]; then
    mkdir -p data
fi
node dist/index.js || echo "⚠️  数据获取失败，但继续部署..."

# 安装后端依赖
echo "📦 安装后端依赖..."
cd "$BACKEND_DIR"
if [ ! -d "node_modules" ]; then
    npm install
fi

# 构建后端代码
echo "🔨 构建后端代码..."
npm run build

# 检查 .env 文件冲突（仅在存在 .env 文件时）
# 如果发现冲突，自动 unset 系统环境变量，优先使用 .env 文件中的值
if [ -f ".env" ]; then
    echo "🔍 检查 .env 文件冲突..."
    conflicts=0
    conflict_vars=""
    while IFS='=' read -r key value || [ -n "$key" ]; do
        # 跳过空行和注释行
        [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
        # 清理 key（去除前后空格）
        key=$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || echo "")
        # 跳过无效的 key
        [ -z "$key" ] && continue
        # 检查 key 是否包含非法字符（只允许字母、数字、下划线）
        [[ ! "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] && continue
        # 获取系统环境变量值（使用 || true 防止失败）
        system_value=$(printenv "$key" 2>/dev/null || echo "")
        if [ -n "$system_value" ]; then
            if [ $conflicts -eq 0 ]; then
                echo "⚠️  发现环境变量冲突，将使用 .env 文件中的值："
            fi
            # 修复：grep 找不到匹配时不会导致脚本退出
            env_value=$(grep "^${key}=" ".env" 2>/dev/null | cut -d'=' -f2- | sed 's/^[[:space:]]*//' || echo "")
            echo "   $key: 系统=$system_value → .env=$env_value (已 unset 系统变量)"
            # 自动 unset 系统环境变量，优先使用 .env 文件中的值
            # 使用 || true 防止 unset 失败导致脚本退出
            unset "$key" 2>/dev/null || true
            conflict_vars="$conflict_vars $key"
            conflicts=$((conflicts + 1))
        fi
    done < ".env"
    if [ $conflicts -eq 0 ]; then
        echo "✅ 未发现环境变量冲突"
    else
        echo "✅ 已清除 $conflicts 个冲突的系统环境变量，将使用 .env 文件中的值"
    fi
    echo ""
fi

case $DEPLOY_METHOD in
    pm2)
        echo "📦 使用 PM2 部署（本地测试用）..."
        echo "⚠️  注意：使用临时配置文件，环境变量从 .env 文件读取（不设置 NODE_ENV）"
        echo "⚠️  生产环境部署请使用根目录的 deploy.sh（远程服务器部署）"
        
        # 检查 PM2 是否安装
        if ! command -v pm2 &> /dev/null; then
            echo "📥 安装 PM2..."
            npm install -g pm2
        fi
        
        # 创建日志目录
        mkdir -p logs
        
        # 停止现有进程（如果存在）
        pm2 delete aave-backend 2>/dev/null || true
        
        # 配置 PM2 日志轮转（如果未配置）
        if ! pm2 list | grep -q "pm2-logrotate"; then
            echo "📦 安装 PM2 日志轮转模块..."
            pm2 install pm2-logrotate
            pm2 set pm2-logrotate:max_size 50M pm2-logrotate:retain 2 pm2-logrotate:compress false
        fi
        
        # 启动应用（PM2 6.x 支持部分命令行参数，但日志配置仍需使用配置文件）
        cd "$ROOT_DIR"
        # 创建临时配置文件（仅用于日志配置，不设置 NODE_ENV，让 .env 文件生效）
        cat > /tmp/aave-backend-pm2.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'aave-backend',
    script: 'dist/server.js',
    cwd: './backend',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    // 不设置 env，让 .env 文件生效
    error_file: './backend/logs/pm2-error.log',
    out_file: '/dev/null',
    log_file: '/dev/null',
    time: true,
    merge_logs: true,
    autorestart: true,
    min_uptime: '10s'
  }]
};
EOF
        # 使用配置文件 + 命令行参数（PM2 6.x 支持的命令行参数会覆盖配置文件中的值）
        pm2 start /tmp/aave-backend-pm2.config.cjs --only aave-backend \
            --max-memory-restart 500M \
            --max-restarts 10 || {
            echo "⚠️  PM2 启动失败"
            rm -f /tmp/aave-backend-pm2.config.cjs
            exit 1
        }
        # 清理临时文件
        rm -f /tmp/aave-backend-pm2.config.cjs
        
        echo "✅ 部署完成！"
        echo "📊 查看状态: pm2 status"
        echo "📋 查看日志: pm2 logs aave-backend"
        echo "🛑 停止服务: pm2 stop aave-backend"
        echo "🔄 重启服务: pm2 restart aave-backend"
        ;;
        
    local)
        echo "💻 本地运行模式（推荐用于本地测试）..."
        echo "⚠️  注意：这种方式不会在后台运行，按 Ctrl+C 停止"
        echo "⚠️  环境变量从仓库根目录 .env 文件读取（NODE_ENV=development）"
        
        cd "$BACKEND_DIR"
        npm start
        ;;
        
    *)
        echo "❌ 未知的部署方式: $DEPLOY_METHOD"
        echo "使用方法: ./deploy.sh [pm2|local]"
        echo "  - local: 本地运行（推荐，使用.env文件配置）"
        echo "  - pm2:   使用PM2运行（测试用，不推荐，建议用根目录deploy.sh）"
        exit 1
        ;;
esac

