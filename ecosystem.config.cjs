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
      // ⚠️ 重要：这里的变量会在应用启动前设置，会阻止 Doppler 拉取的相同变量
      // 只设置固定值或非敏感默认值，不要设置应从 Doppler 拉取的变量
      
      // 固定值：生产环境标识
      NODE_ENV: 'production',
      
      // 默认值：如果系统环境变量或 Doppler 中没有，才使用这些默认值
      // 注意：如果系统环境变量中设置了这些值，Doppler 拉取的相同变量会被忽略
      // 优先级：系统环境变量 > ecosystem.config.cjs 默认值 > Doppler 拉取的值
      PORT: process.env.PORT || '3001',
      ALLOWED_DEV_ORIGINS: process.env.ALLOWED_DEV_ORIGINS || 'https://codex.warp.dev,https://warp.dev,http://103.151.172.89,http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000',
      
      // DOPPLER_TOKEN: 从系统环境变量继承（不要在这里硬编码）
      // 应该在服务器上通过 ~/.bashrc 或 /etc/environment 设置，或使用 pm2 set pm2:env DOPPLER_TOKEN "xxx"
      // 应用启动时会自动从 Doppler 拉取 secrets（如果 DOPPLER_TOKEN 存在）
      // 
      // ⚠️ 环境变量优先级（从高到低）：
      // 1. 系统环境变量（在 PM2 启动时已设置）
      // 2. ecosystem.config.cjs 中的 env 对象
      // 3. Doppler 拉取的值（如果前两者都没有设置）
      // 
      // 如果要从 Doppler 拉取变量，确保：
      // - 不在 ecosystem.config.cjs 中设置该变量
      // - 不在系统环境变量中设置该变量（或确保值正确）
    },
    // PM2 日志配置
    // 注意：应用使用 winston 记录日志到 backend/logs/，PM2 只保留错误日志
    // winston 日志：backend/logs/combined.log 和 backend/logs/error.log（自动轮转，5MB，保留5个文件）
    // PM2 日志：
    //   - pm2-error.log: 进程级别的错误（stderr）
    //   - pm2-out.log: stdout 输出（在 production 中，winston 不输出到 console，所以这个文件通常是空的）
    //   - 如果 winston 的 Console transport 被禁用，pm2-out.log 将只包含非 winston 的输出（如第三方库的日志）
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',  // 保存 stdout（虽然 production 中 winston 不输出，但保留用于调试）
    log_file: './logs/pm2-combined.log',  // 合并日志（error + out）
    time: true,
    merge_logs: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};

