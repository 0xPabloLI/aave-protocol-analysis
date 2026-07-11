#!/bin/bash

# 检查服务器环境配置脚本
# 使用方法: ./check-env.sh

echo "=========================================="
echo "🔍 检查服务器环境配置"
echo "=========================================="
echo ""

# 1. 检查 PM2 进程
echo "1️⃣ 检查 PM2 进程状态:"
if command -v pm2 &> /dev/null; then
    pm2 list
    echo ""
    
    # 检查 aave-backend 进程的环境变量
    echo "2️⃣ 检查 aave-backend 进程的环境变量:"
    pm2 describe aave-backend 2>/dev/null | grep -A 20 "env:" || echo "   ⚠️  aave-backend 进程未运行"
    echo ""
    
    # 获取 NODE_ENV
    echo "3️⃣ 当前 NODE_ENV:"
    NODE_ENV=$(pm2 jlist | jq -r '.[] | select(.name=="aave-backend") | .pm2_env.NODE_ENV // "未设置"' 2>/dev/null || echo "无法获取")
    if [ "$NODE_ENV" = "未设置" ] || [ -z "$NODE_ENV" ]; then
        echo "   ⚠️  NODE_ENV 未设置（将使用默认值）"
    else
        echo "   ✅ NODE_ENV = $NODE_ENV"
    fi
    echo ""
    
    # 获取其他环境变量
    echo "4️⃣ 其他环境变量:"
    pm2 jlist | jq -r '.[] | select(.name=="aave-backend") | .pm2_env | to_entries | .[] | select(.key | startswith("FRONTEND_URL") or startswith("ALLOWED_DEV") or startswith("PORT")) | "   \(.key) = \(.value)"' 2>/dev/null || echo "   无相关环境变量"
    echo ""
else
    echo "   ⚠️  PM2 未安装或未在 PATH 中"
    echo ""
fi

# 2. 检查 .env 文件（统一使用仓库根目录的 .env）
echo "5️⃣ 检查 .env 文件:"
ROOT_ENV="../.env"
if [ -f "$ROOT_ENV" ]; then
    echo "   ✅ 根目录 .env 文件存在 ($ROOT_ENV)"
    echo "   内容:"
    cat "$ROOT_ENV" | sed 's/^/      /'
else
    echo "   ⚠️  根目录 .env 文件不存在 ($ROOT_ENV)"
fi
echo ""

# 3. 检查 ecosystem.config.cjs
echo "6️⃣ 检查 ecosystem.config.cjs 配置:"
if [ -f "../ecosystem.config.cjs" ]; then
    echo "   ✅ ecosystem.config.cjs 存在"
    echo "   NODE_ENV 配置:"
    grep -A 5 "NODE_ENV" ../ecosystem.config.cjs | sed 's/^/      /' || echo "      未找到 NODE_ENV 配置"
else
    echo "   ⚠️  ecosystem.config.cjs 不存在"
fi
echo ""

# 4. 检查系统环境变量
echo "7️⃣ 系统环境变量:"
echo "   NODE_ENV = ${NODE_ENV:-未设置}"
echo "   PORT = ${PORT:-未设置}"
echo "   FRONTEND_URL = ${FRONTEND_URL:-未设置}"
echo "   ALLOWED_DEV_ORIGINS = ${ALLOWED_DEV_ORIGINS:-未设置}"
echo ""

# 5. 总结
echo "=========================================="
echo "📋 环境判断:"
echo "=========================================="

# 判断逻辑
if command -v pm2 &> /dev/null && pm2 list | grep -q "aave-backend"; then
    PM2_NODE_ENV=$(pm2 jlist | jq -r '.[] | select(.name=="aave-backend") | .pm2_env.NODE_ENV' 2>/dev/null)
    
    if [ "$PM2_NODE_ENV" = "production" ]; then
        echo "   ✅ 当前运行环境: 生产环境 (production)"
        echo "   📝 CORS 配置: 如果设置了 FRONTEND_URL，会启用白名单限制"
    elif [ -n "$PM2_NODE_ENV" ]; then
        echo "   ✅ 当前运行环境: $PM2_NODE_ENV"
    else
        echo "   ⚠️  无法确定环境（NODE_ENV 未设置）"
        echo "   📝 默认行为: 开发环境（允许所有来源）"
    fi
else
    echo "   ⚠️  服务未通过 PM2 运行，或 PM2 未安装"
    echo "   📝 如果直接运行 node，NODE_ENV 可能未设置，默认为开发环境"
fi

echo ""
echo "=========================================="
echo "💡 提示:"
echo "=========================================="
echo "1. PM2 配置优先级: ecosystem.config.cjs > .env 文件 > 系统环境变量"
echo "2. 如果使用 PM2，环境变量在 ecosystem.config.cjs 中配置"
echo "3. 如果使用 npm start，环境变量从 .env 文件读取"
echo "4. 修改环境变量后需要重启服务: pm2 restart aave-backend"
echo ""
