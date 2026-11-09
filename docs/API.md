# API 参考

Base URL：`http(s)://<host>:<port>/api`
所有请求与响应均为 `application/json; charset=utf-8`（导出接口除外）。

## 认证

### 会话（浏览器）

```bash
# 1. 登录，服务端下发 HttpOnly Cookie: ks_sid
curl -i -c jar.txt -X POST http://127.0.0.1:3600/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"REPLACE_WITH_A_STRONG_PASSWORD"}'

# 2. 取 CSRF Token（响应中的 csrf）
curl -b jar.txt http://127.0.0.1:3600/api/auth/me

# 3. 写请求必须带 Cookie + X-CSRF-Token
curl -b jar.txt -X POST http://127.0.0.1:3600/api/products \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: <csrf>" \
  -d '{"name":"磁吸支架","cost_cny":3.2,"sale_usd":9.99}'
```

### API Key（脚本 / 集成）

在「设置 → 团队与密钥」创建，仅显示一次。支持 `X-API-Key` 或 `Authorization: Bearer`。

```bash
curl -H "X-API-Key: ks_xxx" http://127.0.0.1:3600/api/products
```

- `read`：仅 GET
- `write`：可调用写接口（仍受角色权限与配额约束）
- API Key 请求不需要 CSRF Token

### 角色

| 角色 | 读 | 商品写 | 生成日报 | 导出 | 设置 | 成员/密钥 | 套餐 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| viewer | ✓ |  |  |  |  |  |  |
| analyst | ✓ | ✓ | ✓ | ✓ |  |  |  |
| admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## 通用约定

- 日期：`YYYY-MM-DD`，按租户时区（`TZ_NAME`，默认 Asia/Shanghai）切天
- 分页：`page`（默认 1）、`pageSize`（默认 20，最大 100）
- 金额：售价与利润为 USD，拿货价为 CNY，毛利率/ROI 为百分数
- 错误：

```json
{
  "error": "bad_request",
  "message": "参数校验失败",
  "details": { "fields": [{ "field": "sale_usd", "message": "字段 sale_usd 不能小于 0.01" }] },
  "request_id": "0b5c..."
}
```

| HTTP | error | 含义 |
| --- | --- | --- |
| 400 | bad_request / bad_json | 参数或 JSON 不合法 |
| 401 | unauthorized | 未登录/会话过期 |
| 402 | quota_exceeded | 套餐配额超限（`details.quota`） |
| 403 | forbidden / csrf_failed / readonly_key / demo_readonly | 权限或安全校验失败 |
| 404 | not_found | 资源不存在 |
| 409 | conflict | 唯一约束冲突（如邮箱已注册） |
| 413 | payload_too_large | 请求体超限 |
| 429 | rate_limited | 触发限流，带 `Retry-After` |
| 502 | provider_unavailable | 外部数据源不可用 |

限流默认值：全局 600 次/分钟/IP；登录 10 次/5 分钟/IP；生成日报 12 次/小时/租户；导出 30 次/小时/租户；推送 120 次/小时/租户。

## 认证接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/login` | 登录，Set-Cookie |
| POST | `/auth/logout` | 注销当前会话 |
| GET | `/auth/me` | 当前用户、租户、套餐、用量、权限、csrf |
| PATCH | `/auth/password` | 修改密码（需 `old_password`，成功后所有会话失效） |
| POST | `/auth/demo` | 仅 `DEMO_MODE=1`，只读演示登录 |

## 商品

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/products` | 列表 + 评分 + 汇总 + 分面 |
| GET | `/products/:id` | 单品详情（含 30 天序列与利润瀑布） |
| POST | `/products` | 新增 |
| PATCH | `/products/:id` | 局部更新（字段同新增，均可选） |
| DELETE | `/products/:id` | 归档（软删除） |
| POST | `/products/:id/restore` | 恢复 |
| POST | `/products/import` | CSV 导入（`{ "csv": "..." }`，≤1000 行） |
| GET | `/products/export.csv` | 导出（计入套餐导出配额） |
| GET | `/products/template.csv` | 导入模板 |
| GET | `/products/stats` | 商品池汇总 |
| GET | `/products/trend?id=1&days=30` | 单品快照序列 |

列表查询参数：`q`、`scene`（temu/tiktok）、`category`、`verdict`（main/test/watch/review/drop）、
`status`（active/archived/all）、`sort`（score/margin/net/trend/competition/confidence/updated/name）、
`order`（asc/desc）、`minScore`、`maxScore`、`risk=1`、`page`、`pageSize`。

商品字段：

```json
{
  "name": "磁吸车载支架 MagSafe",
  "sku": "CAR-MAG-01",
  "category": "车载配件",
  "scene": "temu",
  "cost_cny": 2.99,
  "sale_usd": 9.99,
  "weight_g": 180,
  "trend_score": 82,
  "competition": 78,
  "repurchase": 45,
  "differentiation": 55,
  "logistics": "light",
  "compliance": "low",
  "compliance_reviewed": false,
  "duty_rate": 0.25,
  "target_margin": 0.35,
  "tags": "car mount, magsafe",
  "notes": "类目 BEST-SELLER 常客"
}
```

`duty_rate`、`target_margin` 传 `null` 表示使用全局默认。

CSV 表头支持中英文别名：商品名/name、编码/sku、品类/category、平台/scene、拿货价/cost_cny、
售价/sale_usd、重量g/weight_g、趋势分/trend_score、竞争度/competition、复购/repurchase、
差异化/differentiation、物流/logistics、合规风险/compliance、关税率/duty_rate、目标毛利率/target_margin、备注/notes。
有 `sku` 时按 SKU 覆盖更新。

## 日报

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/reports` | 最近日报（受套餐可回溯天数限制） |
| GET | `/reports/:day` | 某天日报全文 |
| POST | `/reports/generate` | 生成（`{"use_llm": true, "day": "2026-11-09"}` 可选） |
| POST | `/reports/snapshot` | 立即记录当天热度快照 |
| GET | `/reports/:day/markdown` | 下载 Markdown |

生成响应包含 `source`（llm/rule）、`fallbackReason`（降级原因）、`alerts`（本次新增预警）、`notify`（推送结果）。
按 `(tenant, day)` 幂等：同一天重复生成会覆盖。

## 预警

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/alerts?status=open`（可选 `acked` / `all`） | 列表 + 汇总 |
| GET | `/alerts/summary` | 未处理计数 |
| POST | `/alerts/:id/ack` | 标记已处理 |
| POST | `/alerts/ack-all` | 全部标记已处理 |
| POST | `/alerts/rescan` | 按当前规则重新扫描 |

规则：`score_high`、`competition_high`、`compliance_high`、`trend_drop`、`loss`、`low_confidence`。
按 `(product, rule, day)` 去重。

## 设置与团队

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/settings` | 配置、套餐、用量、计费目录、数据源状态 |
| PATCH | `/settings/config` | 局部更新配置（深度合并 + 强校验） |
| POST | `/settings/config/reset` | 恢复默认 |
| POST | `/settings/webhook/test` | 发送测试消息 |
| GET | `/usage` | 本月用量与 LLM 成本 |
| GET | `/audit` | 审计日志（最近 200 条） |
| GET | `/users` / POST `/users` / PATCH `/users/:id` | 成员管理 |
| GET | `/keys` / POST `/keys` / DELETE `/keys/:id` | API Key |
| POST | `/plan` | 手动切换套餐（owner，需已接支付或人工开通） |

配置结构（节选）：

```json
{
  "weights": { "trend": 0.4, "profit": 0.25, "differentiation": 0.2, "repurchase": 0.15 },
  "fees": {
    "temu": { "commission": 0.18, "fulfillment": 0, "ad": 0, "returns": 0, "payment": 0 },
    "tiktok": { "commission": 0.24, "fulfillment": 0, "ad": 0.22, "returns": 0.05, "payment": 0.02 }
  },
  "logistics": {
    "mode": "air", "airUsdPerKg": 6.5, "seaUsdPerKg": 1.2, "packagingUsd": 0.25, "qcUsd": 0.1,
    "fulfillmentModel": "direct",
    "local": { "inboundUsdPerUnit": 0, "storageUsdPerUnit": 0, "lastMileUsdPerUnit": 0, "deadStockPct": 0 }
  },
  "fx": { "usdCny": 7.2, "buffer": 0.02 },
  "duty": { "defaultRate": 0.25, "deMinimisUsd": 0, "perItemDutyUsd": 0, "customsPerOrderUsd": 0 },
  "scoring": {
    "profitTargetMargin": 0.35,
    "competitionThreshold": 60,
    "competitionPenalty": 0.25,
    "compliancePenalty": { "low": 0, "mid": 3, "high": 8 },
    "verdicts": { "main": 78, "test": 62, "watch": 45 }
  },
  "alerts": {
    "scoreThreshold": 78, "trendDropPct": 15, "competitionHigh": 80, "complianceHigh": true,
    "webhook": { "type": "wecom", "url": "https://...", "enabled": true }
  },
  "report": { "topN": 3 }
}
```

## 数据源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/integrations` | 数据源目录与最近同步状态 |
| POST | `/integrations/google-trends/sync` | 拉取公共趋势信号（`geo`、`apply`） |
| POST | `/signals` | 外部推送热度/价格（需 write 权限） |

外部推送示例（自有爬虫/数据服务商）：

```bash
curl -X POST http://127.0.0.1:3600/api/signals \
  -H "X-API-Key: ks_xxx" -H 'Content-Type: application/json' \
  -d '{"items":[{"sku":"CAR-MAG-01","trend_score":83,"price_usd":9.99}]}'
```

单次最多 500 条；`trend_score` 0-100，`price_usd` > 0；写入会落 `snapshots.source = push` 便于审计。

## 运维

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活/数据库状态（无需登录，适合探针） |
| GET | `/meta` | 版本、演示模式、是否配置 LLM |
| GET | `/plans` | 套餐与限额（公开定价页可用） |
