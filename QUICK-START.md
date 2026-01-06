# 快速开始 - 后端部署

## 最简单的方式（推荐）

使用部署脚本一键部署：

```bash
cd backend
./deploy.sh pm2
```

这将自动：
1. 安装所有依赖
2. 构建代码
3. 获取初始数据
4. 使用 PM2 启动服务

## 其他部署方式

### Docker 部署

```bash
cd backend
./deploy.sh docker
```

### 本地运行（测试）

```bash
cd backend
./deploy.sh local
```

## 验证部署

部署完成后，检查服务状态：

```bash
# PM2 方式
pm2 status
pm2 logs aave-backend

# Docker 方式
docker-compose ps
docker-compose logs -f backend

# 健康检查
curl http://localhost:3001/health
```

## 常用命令

### PM2

```bash
pm2 status              # 查看状态
pm2 logs aave-backend   # 查看日志
pm2 restart aave-backend # 重启
pm2 stop aave-backend   # 停止
pm2 delete aave-backend # 删除
```

### Docker

```bash
docker-compose up -d           # 启动
docker-compose down            # 停止
docker-compose restart backend # 重启
docker-compose logs -f backend # 查看日志
```

## 详细文档

查看 [DEPLOY.md](./DEPLOY.md) 获取完整的部署文档。

