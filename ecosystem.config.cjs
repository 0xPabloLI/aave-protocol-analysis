module.exports = {
  apps: [{
    name: 'aave-backend',
    script: 'dist/server.js',
    cwd: './backend',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '500M',
    // 环境变量配置（生产环境专用）
    // 生产最佳实践：不要依赖服务器上的 .env 文件
    // - 应用启动时会优先从 Secret Manager 拉取（例如 Doppler），再回退到本地/开发的根目录 .env
    // - 这里的 env 只放“非敏感默认值”，避免覆盖 Secret Manager 注入的变量
    // 此文件用于生产环境部署（deploy.sh远程部署脚本使用）
    // 本地测试请使用 backend/deploy.sh local 或直接 npm start
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || '3001',
      // 开发/测试环境白名单（非敏感默认值）
      ALLOWED_DEV_ORIGINS: process.env.ALLOWED_DEV_ORIGINS || 'https://codex.warp.dev,https://warp.dev,http://103.151.172.89,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000',
      // DOPPLER_TOKEN: 从系统环境变量继承（不要在这里硬编码）
      // 应该在服务器上通过 ~/.bashrc 或 /etc/environment 设置，或使用 pm2 set pm2:env DOPPLER_TOKEN "xxx"
      // 应用启动时会自动从 Doppler 拉取 secrets（如果 DOPPLER_TOKEN 存在）
    },
    // PM2 日志配置
    // 注意：应用使用 winston 记录日志到 backend/logs/，PM2 只保留错误日志
    // winston 日志：backend/logs/combined.log 和 backend/logs/error.log（自动轮转，5MB，保留5个文件）
    // PM2 日志：backend/logs/pm2-error.log（仅错误，用于PM2进程管理）
    error_file: './logs/pm2-error.log',
    out_file: '/dev/null',  // 不单独保存输出日志，应用日志由 winston 管理
    log_file: '/dev/null',  // 合并日志也通过 pm2 logs 查看
    time: true,
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};

