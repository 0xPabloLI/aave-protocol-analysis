# 本地 main 变更提醒（macOS launchd）

本文档用于在本机定时检查 `origin/main` 是否有新提交，并在检测到变更时弹出通知提醒你手动 rebase。

> 适用场景：本机开发时希望自动提醒，不要求 24/7 常驻。

## 1. 创建检查脚本

新建脚本文件：`~/bin/sync-main-check.sh`

```bash
#!/bin/zsh
set -euo pipefail

REPO="/Users/pabloli/Documents/aave-protocol-analysis"
cd "$REPO"

git fetch origin main --quiet

LOCAL_MAIN="$(git rev-parse main)"
REMOTE_MAIN="$(git rev-parse origin/main)"

if [[ "$LOCAL_MAIN" != "$REMOTE_MAIN" ]]; then
  /usr/bin/osascript -e 'display notification "origin/main 有新提交，建议执行 git rebase origin/main" with title "aave-protocol-analysis"'
fi
```

授权执行：

```bash
chmod +x ~/bin/sync-main-check.sh
```

## 2. 创建 launchd 配置

新建文件：`~/Library/LaunchAgents/com.aave.sync-main.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.aave.sync-main</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>/Users/pabloli/bin/sync-main-check.sh</string>
    </array>

    <!-- 每 900 秒检查一次（15 分钟） -->
    <key>StartInterval</key><integer>900</integer>
    <key>RunAtLoad</key><true/>

    <key>StandardOutPath</key><string>/tmp/com.aave.sync-main.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/com.aave.sync-main.err.log</string>
  </dict>
</plist>
```

## 3. 加载并启用任务

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aave.sync-main.plist
launchctl enable gui/$(id -u)/com.aave.sync-main
```

## 4. 查看状态与日志

查看任务状态：

```bash
launchctl print gui/$(id -u)/com.aave.sync-main
```

查看日志：

```bash
tail -f /tmp/com.aave.sync-main.out.log /tmp/com.aave.sync-main.err.log
```

## 5. 停用/移除

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aave.sync-main.plist
rm ~/Library/LaunchAgents/com.aave.sync-main.plist
```

## 6. 重要说明

1. 这是用户级任务，不需要 sudo。
2. 电脑关机、睡眠期间任务不会运行。
3. 如果需要 24/7 执行，请把调度迁移到云端（GitHub Actions / Railway / n8n）。
