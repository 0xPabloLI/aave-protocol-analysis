import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import marketsRouter from './routes/markets.js';
import { dataService } from './services/dataService.js';
import { startUpdateScheduler } from './services/updateScheduler.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(corsMiddleware);
app.use(express.json());

// Routes
app.use('/api/markets', marketsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动时加载数据到缓存
dataService.loadData()
  .then(() => {
    console.log('✅ Data loaded into cache');
    
    // 启动定时更新任务
    startUpdateScheduler();
    
    // 启动服务器
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('❌ Failed to load data:', error);
    // 即使加载失败也启动服务器（可能是首次运行，数据文件不存在）
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log('⚠️  Data file not found. Please run data fetch script first.');
    });
  });

export default app;
