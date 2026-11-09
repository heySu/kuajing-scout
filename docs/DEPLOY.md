# 部署与运维

## 1. 运行要求

- Node.js **≥ 22.5**（推荐 24 LTS），无需 `npm install`（零运行时依赖）
- 单机 SQLite（WAL 模式），数据目录需持久化并定期备份
- 生产必须：HTTPS、`SESSION_SECRET`、`NODE_ENV=production`、`TRUST_PROXY=1`

## 2. 首次部署

```bash
git clone <repo> /opt/kuajing-scout && cd /opt/kuajing-scout
cp .env.example .env
# 编辑 .env：SESSION_SECRET / BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD / TZ_NAME
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

首次启动会：

1. 创建 `data/scout.db` 并执行迁移（旧版 v0.1 库会自动升级并保留数据）；
2. 创建租户与管理员账号（来自 `BOOTSTRAP_ADMIN_*`）；
3. 若为开发环境，写入演示商品池与示例日报（生产设 `IMPORT_ON_BOOT=0`）。

验证：

```bash
curl -fsS http://127.0.0.1:3600/api/health
```

## 3. systemd

`/etc/systemd/system/kuajing-scout.service`：

```ini
[Unit]
Description=kuajing-scout
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/kuajing-scout
EnvironmentFile=/opt/kuajing-scout/.env
ExecStart=/usr/bin/node --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/kuajing-scout/data /opt/kuajing-scout/reports

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now kuajing-scout
journalctl -u kuajing-scout -f
```

## 4. Nginx + TLS

```nginx
upstream scout { server 127.0.0.1:3600; keepalive 32; }

server {
  listen 443 ssl http2;
  server_name scout.example.com;

  ssl_certificate     /etc/letsencrypt/live/scout.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/scout.example.com/privkey.pem;

  client_max_body_size 2m;          # CSV 导入上限 1MB，留余量
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://scout;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;        # LLM 生成最长 45s + 重试
  }
}

server {
  listen 80;
  server_name scout.example.com;
  return 301 https://$host$request_uri;
}
```

`.env` 对应设置：`TRUST_PROXY=1`、`COOKIE_SECURE=1`、`HOST=127.0.0.1`。

## 5. Docker / Compose

```yaml
services:
  scout:
    build: .
    restart: unless-stopped
    ports: ["127.0.0.1:3600:3600"]
    environment:
      NODE_ENV: production
      SESSION_SECRET: ${SESSION_SECRET}
      BOOTSTRAP_ADMIN_EMAIL: ${ADMIN_EMAIL}
      BOOTSTRAP_ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      IMPORT_ON_BOOT: "0"
      TZ_NAME: Asia/Shanghai
      TRUST_PROXY: "1"
      COOKIE_SECURE: "1"
      REPORT_WRITE_FILES: "0"
    volumes:
      - scout-data:/app/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3600/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  scout-data:
```

## 6. 备份与恢复

热备份（服务运行中可执行，使用 `VACUUM INTO` 生成一致性快照）：

```bash
npm run backup                 # data/backups/scout-YYYYMMDD-HHMMSS.db，默认保留 14 份
node server/cli/backup.js --keep 30
```

建议：

- 每日 02:00 通过 systemd timer / cron 执行备份，并同步到异地或对象存储；
- 备份文件加密（含供应商成本、销售数据）；
- **每季度做一次恢复演练**。

恢复：

```bash
systemctl stop kuajing-scout
cp data/scout.db data/scout.db.bak
cp data/backups/scout-20261109-020000.db data/scout.db
rm -f data/scout.db-wal data/scout.db-shm
systemctl start kuajing-scout
curl -fsS http://127.0.0.1:3600/api/health
```

## 7. 升级

```bash
npm run backup
git pull
npm start            # 启动时自动执行未应用的迁移
```

迁移在一个事务内执行，失败会回滚并拒绝启动；迁移前务必先备份。
旧版（v0.1，单租户）数据库会自动升级：商品/日报/快照保留到默认租户，重复快照按天去重。

## 8. 监控与日志

- 健康检查：`GET /api/health`（含 `db` 状态、版本、时区）
- 日志：JSON 行输出到 stdout（`ts/level/msg/reqId/method/path/status/ms`），可直接接入 Loki/ELK
- 建议告警：健康检查失败、5xx 比例、LLM 失败率、磁盘使用率、备份任务失败
- LLM 成本：`GET /api/usage` 查看本月 token/美元成本，按租户核对账单

## 9. 多实例与扩容

当前架构是**单实例**设计：

- SQLite 单写者，多实例共享同一文件会导致锁竞争；需要水平扩容时迁移到 Postgres（服务层已按 `tenant_id` 隔离，改 DAL 即可）；
- 限流是进程内固定窗口，多实例需换 Redis；
- 定时任务在每个实例都会执行，多实例需加分布式锁或只让一个实例开 `ENABLE_CRON=1`。

## 10. 安全清单（上线前）

- [ ] HTTPS 生效，HTTP 301 跳转
- [ ] `SESSION_SECRET` 随机且 ≥32 字符，未提交到仓库
- [ ] `NODE_ENV=production`、`DEMO_MODE=0`、`IMPORT_ON_BOOT=0`
- [ ] 管理员使用强密码，已禁用默认演示账号
- [ ] 防火墙只暴露 443，应用仅监听 127.0.0.1
- [ ] 备份可用且异地保存
- [ ] 日志保留与脱敏策略（不记录密码/Token）
- [ ] 数据导出与删除流程符合隐私政策
- [ ] 完成一次外部渗透测试或至少 OWASP Top 10 自查

## 11. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报「生产环境必须设置 SESSION_SECRET」 | 缺少密钥 | 生成并写入 `.env` |
| 登录后立即 401 | 反向代理未传 Cookie / `COOKIE_SECURE=1` 但用 HTTP 访问 | 用 HTTPS，或临时 `COOKIE_SECURE=0` |
| 写请求 403 `csrf_failed` | 前端未带 `X-CSRF-Token` 或页面过期 | 刷新页面重新取 csrf |
| 403 `readonly_key` | API Key 只有 read 作用域 | 换 write Key |
| 402 `quota_exceeded` | 套餐上限 | 归档商品/升级套餐 |
| 502 `provider_unavailable` | Google Trends 等外部源不可达 | 检查出网/代理，或改用手动/推送数据源 |
| Webhook 400「禁止向内网地址发送」 | SSRF 防护 | 内网自建时显式设置 `WEBHOOK_ALLOW_PRIVATE=1` |
| 端口占用 `EADDRINUSE` | 已有实例 | 改 `PORT` 或停止旧进程 |
