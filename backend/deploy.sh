#!/bin/bash

# Aave Backend 部署脚本
# 使用方法: ./deploy.sh [pm2|docker|local]

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

case $DEPLOY_METHOD in
    pm2)
        echo "📦 使用 PM2 部署..."
        
        # 检查 PM2 是否安装
        if ! command -v pm2 &> /dev/null; then
            echo "📥 安装 PM2..."
            npm install -g pm2
        fi
        
        # 创建日志目录
        mkdir -p logs
        
        # 停止现有进程（如果存在）
        pm2 delete aave-backend 2>/dev/null || true
        
        # 启动应用（PM2 配置在根目录）
        cd "$ROOT_DIR"
        pm2 start ecosystem.config.cjs || {
            echo "⚠️  如果 PM2 启动失败，请确保 ecosystem.config.cjs 在根目录"
            exit 1
        }
        
        echo "✅ 部署完成！"
        echo "📊 查看状态: pm2 status"
        echo "📋 查看日志: pm2 logs aave-backend"
        echo "🛑 停止服务: pm2 stop aave-backend"
        echo "🔄 重启服务: pm2 restart aave-backend"
        ;;
        
    docker)
        echo "🐳 使用 Docker 部署..."
        
        # 检查 Docker 是否安装
        if ! command -v docker &> /dev/null; then
            echo "❌ Docker 未安装，请先安装 Docker"
            exit 1
        fi
        
        cd "$ROOT_DIR"
        
        # 构建并启动容器
        docker-compose up -d --build
        
        echo "✅ 部署完成！"
        echo "📊 查看状态: docker-compose ps"
        echo "📋 查看日志: docker-compose logs -f backend"
        echo "🛑 停止服务: docker-compose down"
        ;;
        
    local)
        echo "💻 本地运行模式..."
        echo "⚠️  注意：这种方式不会在后台运行，按 Ctrl+C 停止"
        
        cd "$BACKEND_DIR"
        npm start
        ;;
        
    *)
        echo "❌ 未知的部署方式: $DEPLOY_METHOD"
        echo "使用方法: ./deploy.sh [pm2|docker|local]"
        exit 1
        ;;
esac

