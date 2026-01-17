# Cloudflare Browser Rendering 集成指南

如果 Puppeteer 方案不够稳定或需要更好的性能，可以使用 Cloudflare Workers 的 Browser Rendering API。

## 方案对比

### 当前方案：Puppeteer
- ✅ 本地运行，完全控制
- ✅ 免费（除了服务器成本）
- ❌ 需要安装 Chrome/Chromium
- ❌ 资源消耗较大
- ❌ 并发处理有限

### Cloudflare Browser Rendering
- ✅ 云端运行，无需本地浏览器
- ✅ 高性能，支持高并发
- ✅ 自动扩展
- ❌ 需要 Cloudflare 账户
- ❌ 可能有费用（取决于使用量）

## 集成步骤

### 1. 创建 Cloudflare Worker

创建 `cloudflare-browser-worker.js`:

```javascript
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }
    
    // 使用 Cloudflare Browser Rendering API
    // 注意：这需要 Cloudflare Workers Browser Rendering 功能（可能需要付费计划）
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    const html = await response.text();
    
    // 返回渲染后的 HTML
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
```

### 2. 使用 Playwright on Cloudflare Workers

更好的方案是使用 Playwright on Cloudflare Workers（如果可用）：

```javascript
// wrangler.toml
name = "merit-browser-renderer"
main = "src/index.js"
compatibility_date = "2024-01-01"

[env.production]
routes = [
  { pattern = "browser-renderer.yourdomain.com", zone_name = "yourdomain.com" }
]
```

```javascript
// src/index.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    
    if (!targetUrl) {
      return new Response('Missing url parameter', { status: 400 });
    }
    
    // 使用 Playwright on Cloudflare Workers
    // 注意：这需要 Cloudflare Workers Browser Rendering 功能
    const browser = await env.BROWSER.launch();
    const page = await browser.newPage();
    
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    
    // 等待页面加载
    await page.waitForSelector('body');
    
    // 尝试点击 Campaign info 按钮
    try {
      const buttons = await page.$$('button');
      for (const button of buttons) {
        const text = await page.evaluate(el => el.textContent, button);
        if (text && /campaign\s+info/i.test(text)) {
          await button.click();
          await page.waitForTimeout(1500);
          break;
        }
      }
    } catch (e) {
      // 忽略错误
    }
    
    // 提取表格数据
    const campaignInfos = await page.evaluate(() => {
      const infos = [];
      const tables = document.querySelectorAll('table');
      
      for (const table of tables) {
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            const action = cells[0]?.textContent?.trim() || '';
            const description = cells[1]?.textContent?.trim() || '';
            if (action && description && action.length > 0 && description.length > 20) {
              infos.push({ action, description });
            }
          }
        }
      }
      
      return infos;
    });
    
    await browser.close();
    
    return new Response(JSON.stringify(campaignInfos), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
```

### 3. 修改 TypeScript 代码调用 Cloudflare Worker

在 `src/merit-api.ts` 中添加：

```typescript
/**
 * 使用 Cloudflare Browser Rendering 提取 Campaign info
 */
async function extractCampaignInfoWithCloudflare(key: string): Promise<MeritCampaignInfo[]> {
  try {
    const url = `https://apps.aavechan.com/merit/${key}`;
    const cloudflareWorkerUrl = process.env.CLOUDFLARE_BROWSER_WORKER_URL || 'https://browser-renderer.yourdomain.com';
    
    const response = await fetch(`${cloudflareWorkerUrl}?url=${encodeURIComponent(url)}`);
    
    if (!response.ok) {
      throw new Error(`Cloudflare worker error: ${response.status}`);
    }
    
    const campaignInfos = await response.json() as MeritCampaignInfo[];
    return campaignInfos;
  } catch (error) {
    logger.error(`Error extracting campaign info with Cloudflare for key ${key}:`, error);
    return [];
  }
}
```

然后在 `fetchMeritTimeRange` 中使用：

```typescript
// 优先级 #1：尝试 Cloudflare Browser Rendering
let message = await extractCampaignInfoWithCloudflare(key);

// 优先级 #2：如果 Cloudflare 失败，使用本地 Puppeteer
if (message.length === 0) {
  message = await extractCampaignInfoWithBrowser(key);
}

// 优先级 #3：如果都失败，fallback 到 HTML 解析
if (message.length === 0) {
  message = extractCampaignInfo(html);
}
```

## 注意事项

1. **Cloudflare Browser Rendering 功能**：
   - 可能需要 Cloudflare Workers Paid 计划
   - 检查 Cloudflare 文档确认 Browser Rendering API 的可用性

2. **成本考虑**：
   - Cloudflare Workers 有免费额度，但 Browser Rendering 可能额外收费
   - 评估使用量和成本

3. **备选方案**：
   - 如果 Cloudflare 不可用，可以考虑：
     - **Browserless.io**: 托管 Puppeteer 服务
     - **ScrapingBee**: 浏览器渲染 API
     - **Apify**: 网页抓取平台

## 推荐方案

基于当前测试结果，**Puppeteer 方案已经成功**，建议：
1. 继续使用 Puppeteer 方案（已实现并测试通过）
2. 如果遇到性能或稳定性问题，再考虑 Cloudflare 或其他托管服务
3. 保持当前的 fallback 机制（Browser → DOM → Regex）
