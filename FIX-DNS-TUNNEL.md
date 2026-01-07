# 修复 DNS 记录指向 Tunnel

## 问题

DNS 记录可能指向了错误的 Tunnel 地址。需要确保 DNS 记录指向正确的 Tunnel ID。

## 当前 Tunnel ID

```
36779041-1145-4c6a-bf62-600aad4111cb
```

## 正确的 DNS 配置

在 Cloudflare Dashboard 中：

1. 进入 DNS → Records
2. 找到 `api` 记录
3. 编辑记录：
   - **Type**: CNAME
   - **Name**: `api`
   - **Target**: `36779041-1145-4c6a-bf62-600aad4111cb.cfargotunnel.com`
   - **Proxy status**: Proxied (橙色云朵)
   - **TTL**: Auto
4. 保存

## 验证

修改后等待 1-2 分钟，然后测试：

```bash
curl https://api.aaveapy.com/health
```

应该返回：
```json
{"status":"ok","timestamp":"..."}
```

## 如果还是不行

可能需要删除旧的 DNS 记录，然后重新创建。

