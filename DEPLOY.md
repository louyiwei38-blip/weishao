# 服务器部署指南

> 架构与运行逻辑见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

---

## 一、服务器要求

| 项目 | 要求 |
|------|------|
| 系统 | Linux（Ubuntu 22.04+ 推荐）或 Windows Server |
| Node.js | **18+**（推荐 20 LTS） |
| 内存 | ≥ 512MB |
| 网络 | 见下方「网络连通性」 |
| 钱包 | Polymarket 已充值 pUSD，建议 ≥ $30 |

### 网络连通性

| 端点 | 用途 |
|------|------|
| `https://gamma-api.polymarket.com` | 1h 盘口发现 |
| `https://clob.polymarket.com` | 下单、余额、成交查询 |
| `wss://ws-live-data.polymarket.com` | **Chainlink RTDS 结算**（必需） |
| OKX REST API | CCXT K 线（国内推荐，勿依赖币安） |

---

## 二、上传项目

**不要上传** `node_modules/`、`.env`。

```bash
git clone <你的仓库> ~/polymarket-bot
cd ~/polymarket-bot
npm install --production
```

依赖含 `ws` 包（Node 18 无内置 WebSocket 时使用）。

---

## 三、配置 `.env`

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

### 必填项（实盘 DRY_RUN=false）

```env
POLY_PRIVATE_KEY_ENCRYPTED=...    # 或 POLY_PRIVATE_KEY
POLY_KEY_PASSWORD=...             # 加密私钥时必填

OHLCV_EXCHANGE=okx
TRADING_SYMBOL=BTC/USDT
TRADE_BUDGET_USD=3
MIN_BALANCE_USD=0
ORDER_TYPE=GTC
DRY_RUN=false
```

`POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` **可选**——留空时启动会自动 `createOrDeriveApiKey()`；也可 `npm run create-api-key` 预写入以加快启动。

> 空跑 `DRY_RUN=true` 时私钥与 API 凭证均可省略。

### 推荐一并配置

```env
# Chainlink 结算
CHAINLINK_SETTLE_BUFFER_MS=3000
CHAINLINK_BUFFER_MINUTES=30

# 限价成交监视
FILL_SYNC_POLL_MS=500
FILL_SYNC_MAX_WAIT_MS=8000
LIMIT_PRICE_OFFSET_TICKS=0

# 价格封顶（可选）
# ORDER_PRICE_CAP=0.95
TRADE_BUDGET_USD=3

# Telegram（可选）
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### 上线实盘

```env
DRY_RUN=false
```

---

## 四、空跑验证

```bash
export POLY_KEY_PASSWORD="你的解密密码"
DRY_RUN=true node src/index.js
```

**正常日志应包含：**

```
[chainlink] RTDS connected ...
[chainlink] RTDS buffer ready (BTC/USDT=...ticks)
[settle] Chainlink settler started
━━━ cycle start
```

不应持续出现 `OHLCV fetch failed` 或 `WebSocket unavailable`。

单次周期测试：

```bash
DRY_RUN=true node scripts/test-cycle.js
```

---

## 五、PM2 常驻（多标的 × 多周期，由 `.env` 决定）

在 `.env` 配置：

```env
TRADING_SYMBOLS=BTC,ETH          # 只要改这一行即可扩标的
CANDLE_TIMEFRAMES=5m,15m,1h      # 可选
```

```bash
sudo npm install -g pm2
cd ~/polymarket-bot
mkdir -p logs

export POLY_KEY_PASSWORD="你的解密密码"
npm run pm2:dry          # 或 npm run pm2:start 实盘
pm2 logs                 # V3-btc-5m / V3-eth-15m 等
pm2 save && pm2 startup
```

切换实盘：`.env` 配好私钥后 `npm run pm2:start`。

> **`.env` 优先级：** 预算 / 马丁 / 结算 / OHLCV / Telegram / **TRADING_SYMBOLS** 等以 `.env` 为准。  
> PM2 仅覆盖：`BOT_INSTANCE`、`CANDLE_TIMEFRAME`、`MARKET_CYCLE_MINUTES`、`TRADING_SYMBOL`、`DRY_RUN`、`TELEGRAM_MESSAGE_THREAD_ID`。  
> 改完 `TRADING_SYMBOLS` 后必须 `pm2 delete all` 再 `npm run pm2:start`（进程列表会变，不能只 restart）。

### Telegram 论坛话题（推荐：一个群按实例拆话题）

1. 新建 Telegram **群组** → 开启 **Topics（话题）**  
2. 把 Bot 拉进群并设为管理员（需能管理话题）  
3. `.env` 填好 `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（群 ID，多为 `-100…`）  
4. 按当前 `TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` 生成话题并写入 thread id：

```bash
npm run setup:tg-topics -- --write-env
# 或先预览：npm run setup:tg-topics -- --dry
```

5. 验证某个话题：

```bash
node scripts/test-telegram.js --instance=btc-5m
```

6. 重启 PM2：`pm2 delete all && npm run pm2:start`

---

## 六、日志与状态文件

多实例按周期隔离（`BOT_INSTANCE` / timeframe 后缀）：

| 路径 | 内容 |
|------|------|
| `logs/bot-15m.log` / `bot-5m.log` | Winston 主日志 |
| `logs/signals-15m.jsonl` 等 | 每轮信号 |
| `logs/trades-15m.jsonl` 等 | 下单 |
| `logs/settlements-15m.jsonl` 等 | 结算 |
| `logs/stats-state-15m.json` 等 | 盈亏统计 |
| `logs/pending-bet-15m.json` 等 | 待结算注单 |
| `logs/heartbeat-15m.json` 等 | 心跳 |
| `logs/martingale-state.json` | 马丁（内部按 `symbol:timeframe` 分轨） |
| `logs/vegas-state.json` | 维加斯相位（同上分轨） |
| `logs/martingale-state.json` | 马丁状态 |
| `logs/daily-loss.json` | 当日 UTC 累计亏损 |
| `logs/heartbeat.json` | 最近一轮快照 |

### 排查结算

```bash
# 最近结算
tail -5 logs/settlements.jsonl | jq .

# 是否有 pending 卡住
cat logs/pending-bet.json

# 统计快照（重启后从 settlements 重建）
jq '{total, today, beijingDate}' logs/stats-state.json

# Chainlink 是否就绪
grep chainlink logs/bot.log | tail -20
```

---

## 七、安全检查清单

- [ ] `.env` 权限 `chmod 600`，未提交 Git
- [ ] `POLY_KEY_PASSWORD` 仅存在于服务器
- [ ] `DRY_RUN=true` 空跑 ≥1 小时无报错
- [ ] 日志有 `RTDS buffer ready`
- [ ] pUSD 余额 ≥ `MIN_BALANCE_USD`
- [ ] `OHLCV_EXCHANGE=okx`（国内）
- [ ] `ORDER_TYPE=GTC` 时已理解限价可能周期内未成交（马丁不变）

---

## 八、常见问题

| 现象 | 处理 |
|------|------|
| `POLY_KEY_PASSWORD is missing` | `export POLY_KEY_PASSWORD=...` 后重启 |
| `OHLCV fetch failed` | 设 `OHLCV_EXCHANGE=okx` |
| `WebSocket unavailable` | `npm install` 确保 `ws` 已装；Node ≥ 18 |
| `[chainlink] RTDS disconnected` | 检查到 `ws-live-data.polymarket.com` 的网络；会自动重连 |
| `pUSD balance below minimum` | 充值或降低 `MIN_BALANCE_USD` |
| `no BTC 1h market found` / `market_not_found` | 检查 `TRADING_SYMBOL` 与 Polymarket 是否有对应 1h 盘口；等下一周期 |
| 信号方向与预期不符 | 维加斯穿越：上穿入→买涨、下穿入→买跌；见 README 策略表 |
| 盘口超阈值未成交 | 按 `ORDER_PRICE_CAP` 限价挂单，等价格回落；周期内未成交马丁不变 |
| 限价挂单未成交 | 正常；周期结束未成交不计马丁；可调 `LIMIT_PRICE_OFFSET_TICKS` |
| `Chainlink vs exchange OHLCV mismatch` | 告警 only；结算以 Chainlink 为准 |
| FOK `425 service not ready` | 新盘口流动性未就绪；Bot 会自动重试 |

---

## 九、systemd（可选）

见原文 `/etc/systemd/system/polymarket-bot.service` 配置，`Environment=POLY_KEY_PASSWORD=...` 必填。

```bash
sudo systemctl enable polymarket-bot
sudo journalctl -u polymarket-bot -f
```
