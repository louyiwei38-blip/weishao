# Polymarket Previous-Candle Bot

**PRD v2.2+** · 可配置标的 5m · Martingale 4-loss stop · CLOB V2 · Chainlink 结算 · GTC 限价 · 波动率 / 统计风控

Polymarket 5 分钟涨跌盘口自动交易机器人：根据上一根已收盘 K 线方向产生信号，CLOB 限价/市价下单，Chainlink oracle 结算，马丁格尔管理仓位；支持多标的、盈亏统计与波动率下限风控。

> 详细架构见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（信号 / 下单 / 成交监视 / 结算全链路）

---

## 策略

基于**上一根已收盘**的 5m K 线（`K[-1]`）：

| 条件 | 信号 | 操作 |
|------|------|------|
| 上一根阳线 (close > open) | **S1** UP | 当前盘口买涨（YES token） |
| 上一根阴线 | **S2** DOWN | 当前盘口买跌（NO token） |
| 上一根十字星 (open = close) | NONE | 跳过，不下单 |

- 信号产生后，交易**当前刚开盘**的 5m 盘口（`{base}-updown-5m-{windowStartUnix}`，如 `eth-updown-5m-…`，由 `TRADING_SYMBOL` 决定）。
- **标的**：`TRADING_SYMBOL` 同时驱动 CCXT 信号 K 线、Chainlink 订阅与 Polymarket slug（支持 BTC/ETH/SOL/BNB 等）。
- **信号**：CCXT 拉取交易所 5m OHLCV（OKX / Binance / Bybit，自动 fallback）。
- **结算**：Polymarket RTDS Chainlink（`close >= target → UP`），与官方 oracle 一致。
- **下单**：默认 GTC 限价（best ask 挂单 + 成交补偿轮询）；可改 `ORDER_TYPE=FOK` 市价。
- **波动率风控**：独立拉 1m K 线计算 rv；低于 `MIN_RV_*` 下限则跳过本周期（策略需要波动足够大）。
- **统计**：累计/今日盈亏、胜率、止损次数（今日按北京时间）；启动时从 `settlements.jsonl` 回填。

---

## 快速开始

```bash
npm install
cp .env.example .env          # 编辑配置（实盘只需私钥，API 凭证可自动 derive）
# 可选：npm run create-api-key  # 预生成 L2 凭证写入 .env
node scripts/check-env.js
npm run dry                   # 空跑
npm start                     # 正式运行
```

---

## 项目结构

```
src/
├── index.js                         # 调度入口
├── config.js
├── collector/
│   ├── binance.js                   # CCXT OHLCV（信号）
│   └── chainlink.js                 # RTDS Chainlink（结算）
├── strategy/reversalContinuation.js # 上一根 K 线跟随（S1 买涨 / S2 买跌）
├── market/polymarket.js             # Gamma 盘口（slug 随 TRADING_SYMBOL）
├── stats/manager.js                 # 盈亏 / 胜率 / 止损统计
├── trader/
│   ├── executor.js                  # CLOB 下单 GTC/FOK
│   ├── fillSync.js                  # 成交解析 + 短时轮询
│   ├── restingFillWatcher.js        # GTC 周期内补偿轮询
│   └── chainlinkSettle.js           # Chainlink 结算调度
├── martingale/manager.js
└── utils/                           # logger, retry, websocket, telegram, volatility…
docs/
└── ARCHITECTURE.md                  # 架构与运行逻辑（推荐阅读）
logs/
├── signals.jsonl
├── trades.jsonl
├── settlements.jsonl                # Chainlink 结算记录（统计回填源）
├── stats-state.json                 # 盈亏 / 胜率 / 止损快照
├── pending-bet.json                 # 待结算注单
└── martingale-state.json
```

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### 信号 / 结算

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADING_SYMBOL` | BTC/USDT | 信号 K 线 + Chainlink + Polymarket slug 标的 |
| `OHLCV_EXCHANGE` | okx | K 线主交易所（国内建议 okx） |
| `SIGNAL_DELAY_MS` | 10000 | 5m 边界后延迟再拉 K 线 |
| `CHAINLINK_SETTLE_BUFFER_MS` | 3000 | 周期结束后取 Chainlink 收盘价前的等待 |
| `CHAINLINK_SAFETY_INTERVAL_MS` | 60000 | 补结算安全网间隔 |

### 下单 / 成交

| 变量 | 默认 | 说明 |
|------|------|------|
| `ORDER_TYPE` | FOK* | `GTC` 限价（推荐）/ `FOK` 市价 |
| `LIMIT_PRICE_OFFSET_TICKS` | 0 | 限价相对 best ask 的 tick 偏移 |
| `FILL_SYNC_POLL_MS` | 500 | 提交后 getOrder 轮询间隔 |
| `FILL_SYNC_MAX_WAIT_MS` | 8000 | 短时轮询最长等待；超时后 GTC 进入补偿监视 |
| `ORDER_FILL_ATTEMPTS` | 8 | FOK 未成交重试次数 |

\* 代码默认 `FOK`；`.env.example` 推荐生产使用 `GTC`。

### 马丁 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 3 | 马丁基础注 |
| `MARTINGALE_MULTIPLIER` | 2 | 连亏翻倍 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏止损次数 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限 |
| `MAX_BET_USD` | 10000 | 单笔下注上限 |
| `MIN_BALANCE_USD` | 0 | 余额下限（0=不限制） |
| `SKIP_IF_YES_PRICE_OUT_OF_RANGE` | true | YES 价格超出范围时跳过 |
| `VOLATILITY_BAR_TIMEFRAME` | 1m | 波动率专用 K 线周期 |
| `MIN_RV_1M` / `MIN_RV_5M` / `MIN_RV_15M` | 0 | rv 下限；低于则跳过（0=不限制；旧名 `MAX_RV_*` 仍兼容） |
| `DRY_RUN` | false | true = 模拟下单 |

Polymarket / 钱包 / Telegram 变量见 `.env.example`。

---

## 运行逻辑摘要

```
每 5m → CCXT K 线 → 上一根 K 线信号 → 波动率下限检查 → CLOB 下单
                              ├─ rv 过低 → 跳过 + Telegram
                              ├─ 成交 → pending-bet → Chainlink 结算 → 马丁 + 统计
                              └─ GTC 挂单 → 周期内补偿轮询 → 成交后同上
```

- 未成交 / 跳过：马丁**不变**。
- 结算前 `getOrder` 验成交；Chainlink 与交易所 K 线不一致仅告警。
- 开单 / 跳过 / 结算 Telegram 均附带**波动率**与**累计统计**块。

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 正式运行 |
| `npm run dry` | 空跑 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 API 凭证 |
| `node scripts/check-env.js` | 检查配置 |
| `DRY_RUN=true node scripts/test-cycle.js` | 单次周期测试 |

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**（PM2、加密私钥、`OHLCV_EXCHANGE=okx`、RTDS 连通性）。

### 多账号

```bash
git clone <仓库> ~/PMfanz2 && cd ~/PMfanz2 && npm install
cp .env.example .env
pm2 start src/index.js --name pmfanz2 --time
```

---

## 注意事项

- 钱包需有足够 **pUSD**（≥ `MIN_BALANCE_USD`）
- 国内服务器：`OHLCV_EXCHANGE=okx`；需能访问 `wss://ws-live-data.polymarket.com`
- 首次部署建议 `DRY_RUN=true` 空跑，日志应出现 `[chainlink] RTDS buffer ready`
- 限价单周期内未成交不计入马丁；FOK 流动性不足会自动重试后跳过
