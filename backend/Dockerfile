# 使用 Node.js 20 LTS 作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 复制根目录的 package.json 和 package-lock.json（用于安装数据获取脚本的依赖）
COPY package*.json ./
COPY tsconfig.json ./

# 安装根目录依赖（包含数据获取脚本所需的依赖）
RUN npm ci --production=false

# 复制根目录源代码
COPY src ./src

# 构建根目录的 TypeScript 代码（数据获取脚本）
RUN npm run build

# 复制后端 package.json 和 package-lock.json
COPY backend/package*.json ./backend/
COPY backend/tsconfig.json ./backend/

# 安装后端依赖
WORKDIR /app/backend
RUN npm ci --production=false

# 复制后端源代码
COPY backend/src ./src

# 构建后端 TypeScript 代码
RUN npm run build

# 创建数据目录和日志目录
RUN mkdir -p /app/data /app/backend/logs

# 设置工作目录回到根目录（因为数据获取脚本需要在根目录运行）
WORKDIR /app

# 暴露端口（使用环境变量，云平台会自动设置）
EXPOSE ${PORT:-3001}

# 启动命令：先运行一次数据获取，然后启动后端服务器
# 后端服务器在 backend 目录运行（因为路径配置基于 backend 目录）
# 注意：云平台会自动设置 PORT 环境变量
CMD ["sh", "-c", "cd /app && node dist/index.js || echo 'Warning: Initial data fetch failed, continuing...' && cd /app/backend && node dist/server.js"]

