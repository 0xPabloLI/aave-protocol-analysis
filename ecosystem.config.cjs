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
    // 注意：PM2配置文件中的env会覆盖.env文件中的配置
    // 此文件用于生产环境部署（deploy.sh远程部署脚本使用）
    // 本地测试请使用 backend/deploy.sh local 或直接 npm start
    env: {
      NODE_ENV: 'production',
      // PORT 从 backend/.env 文件读取，或使用系统环境变量
      // 如果都没有设置，server.ts 会使用默认值 3001
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

