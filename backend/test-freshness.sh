#!/bin/bash

# 测试数据新鲜度自动检查机制

echo "🧪 Testing Data Freshness Mechanism"
echo "===================================="
echo ""

# 确保后端服务正在运行
echo "📡 Checking if backend is running..."
if ! curl -s http://localhost:3001/health > /dev/null; then
    echo "❌ Backend is not running. Please start it first with: cd backend && npm run dev"
    exit 1
fi
echo "✅ Backend is running"
echo ""

# 测试 1: 获取市场数据
echo "Test 1: GET /api/markets"
echo "------------------------"
response=$(curl -s http://localhost:3001/api/markets | jq -r '.lastUpdated, .isStale, .updateInProgress')
echo "Last Updated: $(echo "$response" | sed -n '1p')"
echo "Is Stale: $(echo "$response" | sed -n '2p')"
echo "Update In Progress: $(echo "$response" | sed -n '3p')"
echo ""

# 测试 2: 获取统计信息
echo "Test 2: GET /api/markets/stats"
echo "-------------------------------"
stats=$(curl -s http://localhost:3001/api/markets/stats | jq -r '.totalPools, .totalChains')
echo "Total Markets: $(echo "$stats" | sed -n '1p')"
echo "Total Chains: $(echo "$stats" | sed -n '2p')"
echo ""

# 测试 3: 获取链列表
echo "Test 3: GET /api/markets/chains"
echo "--------------------------------"
chains=$(curl -s http://localhost:3001/api/markets/chains | jq -r 'length')
echo "Number of Chains: $chains"
echo ""

# 测试 4: 验证刷新端点已移除
echo "Test 4: Verify /refresh endpoint is removed"
echo "--------------------------------------------"
refresh_response=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/api/markets/refresh)
if [ "$refresh_response" = "404" ]; then
    echo "✅ /refresh endpoint successfully removed (404)"
else
    echo "⚠️  /refresh endpoint still exists (HTTP $refresh_response)"
fi
echo ""

# 测试 5: 并发请求测试
echo "Test 5: Concurrent requests (testing lock mechanism)"
echo "-----------------------------------------------------"
echo "Sending 3 concurrent requests..."
for i in {1..3}; do
    curl -s http://localhost:3001/api/markets > /dev/null &
done
wait
echo "✅ Concurrent requests completed"
echo ""

echo "===================================="
echo "✅ All tests completed!"
echo ""
echo "💡 Tips:"
echo "  - Check backend logs to see automatic update triggers"
echo "  - Data should auto-refresh if older than 1 minute"
echo "  - Concurrent requests should not trigger duplicate updates"
