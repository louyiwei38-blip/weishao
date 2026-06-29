# Polymarket Single-Candle Follow Bot

**PRD v2.4+** · OKX 永续 5m · 单 K 线跟随 · 活跃度探测 · Martingale 4-loss stop · CLOB V2 · OKX/Chainlink 结算 · GTC 限价

Polymarket 5 分钟涨跌盘口自动交易机器人：从 **OKX USDT 永续**拉 5m K 线产生信号，**活跃度探测**过滤低成交时段，CLOB 限价/市价下单，默认 **OKX 永续 K 线**结算（可选 Chainlink oracle），马丁格尔管理仓位。

> 详细架构见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（信号 / 下单 / 成交监视 / 结算全链路）

---

## 策略

基于**上一根已收盘** 5m K 线（`K[-1]`），**单 K 线跟随**模式：

| 条件 | 信号 | 操作 |
|------|------|------|
| `K[-1]` 阳线（close > open） | **S1** UP | 买涨（YES token） |
| `K[-1]` 阴线（close < open） | **S2** DOWN | 买跌（NO token） |
| 十字线（open = close） | NONE | 跳过 |

**语义：** 上一根 K 线方向即为下一 Polymarket 5m 窗口的押注方向。

> K 线数据源默认 **OKX BTC/USDT:USDT 永续**（`OHLCV_MARKET_TYPE=swap`），与 `TRADING_SYMBOL`（Polymarket slug / 结算标的）可分离配置。

---

## 活跃度探测

默认 **开启**（`SESSION_GATE_ENABLED=true`）。每 5m 收盘统计近窗活跃度，**探测达标根数 ≥ 11 才开单**（方案 A）；未达标则跳过（仍结算 pending 注单）。

### 探测逻辑

1. **活跃度统计**：近 `ACTIVITY_WINDOW_BARS` 根（默认 12 根 = 1h）5m K 线中，USDT 成交额（`volume × close`）≥ `ACTIVITY_PROBE_USDT_MIN` 的根数 → `hits`
2. **开单条件**：`hits ≥ ACTIVITY_MIN_HITS`（**默认 11**）→ 允许交易；否则跳过
3. **12 档分级**：`hits` 映射为档位 1–12，决定首注金额（见下）

### 方案 A 默认（365d 扣费回测 net ROI ~3.2% @ $0.50）

| 参数 | 值 |
|------|-----|
| `ACTIVITY_PROBE_USDT_MIN` | 30,000,000（30M） |
| `ACTIVITY_MIN_HITS` | 11 |
| `ACTIVITY_TIER_BETS` | `3,3,3,3,3,3,3,3,6,9,15,24` |

### 档位与首注金额

每档对应不同的**首单下注金额**（`ACTIVITY_TIER_BETS`，共 12 个值）。马丁格尔在连亏时从当前首注翻倍，**仅在赢单或触发连亏止损时**，才按**当时活跃度档位**更新首注：

| 事件 | 首注行为 |
|------|----------|
| 赢 | 按结算时刻档位 → 更新 `baseBet` |
| 连亏止损（4 次） | 按结算时刻档位 → 更新 `baseBet`，下周期跳过 |
| 连亏未止损 | 首注不变，仅 `currentBet` 翻倍 |

未配置 `ACTIVITY_TIER_BETS` 时，默认 **highTierOnly**（档 1–8 = `TRADE_BUDGET_USD`，档 9–12 = ×2/×3/×5/×8）。

| 档位 | hits | 默认首注 | 能否开单（方案 A） |
|------|------|----------|-------------------|
| 1–9 | 0–8 | $3–$13.5 | ✗ |
| 10–12 | 9–11+ | $6–$24 | ✓（需 hits≥11） |

日志：`logs/session.jsonl`（含 `activityTier`）、`logs/martingale-state.json`（含 `baseBet` / `lockedTier`）。

关闭探测：`SESSION_GATE_ENABLED=false`（等同常开，仍按档位计算首注参考值）。

### 当前不做的事

- ~~双 K 线反转延续~~（已改为单 K 线跟随）
- ~~rv 阈值切换信号方向~~（rv 仅日志 / Telegram）
- ~~rv_ratio / 成交量 per-trade 过滤~~
- 不使用 AI / 置信度打分

### 波动率字段

仍会拉取 **1m K 线**计算 `rv_5m` / `rv_15m`，**仅写入日志与 Telegram**，不参与信号方向或 per-trade 过滤。

---

## 结算

| `SETTLE_SOURCE` | 数据源 | 规则 |
|-----------------|--------|------|
| `okx`（**默认**） | OKX 永续 5m K 线 | `close >= open → UP`，否则 DOWN |
| `chainlink` | Polymarket RTDS | `close >= target → UP`（需 RTDS 连通） |

`SETTLE_SOURCE=chainlink` 时启动 Chainlink RTDS 缓冲；默认 OKX 模式跳过 RTDS，无需 `wss://ws-live-data.polymarket.com`。

---

## 快速开始

```bash
npm install
cp .env.example .env          # 已含方案 A；模拟盘 DRY_RUN=true，无需私钥
node scripts/check-env.js
npm run dry                   # 本地空跑
npm run pm2:dry               # 服务器 PM2 模拟盘
```

---

## 项目结构

```
src/
├── index.js                         # 调度入口
├── config.js
├── collector/
│   ├── binance.js                   # CCXT OHLCV（OKX 永续 5m + 1m rv）
│   └── chainlink.js                 # RTDS Chainlink（SETTLE_SOURCE=chainlink）
├── strategy/reversalContinuation.js # S1/S2 单 K 线跟随
├── session/sessionGate.js           # 活跃度探测 + 动态触发线
├── market/polymarket.js             # Gamma 盘口（slug 随 TRADING_SYMBOL）
├── stats/manager.js                 # 盈亏 / 胜率 / 止损统计
├── trader/
│   ├── executor.js                  # CLOB 下单 GTC/FOK
│   ├── fillSync.js                  # 成交解析 + 短时轮询
│   ├── restingFillWatcher.js        # GTC 周期内补偿轮询
│   └── chainlinkSettle.js           # OKX / Chainlink 结算调度
├── martingale/manager.js
└── utils/                           # logger, retry, telegram, volatility, volumeFilter…
scripts/
├── backtest-session-gate-v2.js      # 活跃度探测回测
├── backtest-daily-vol-pnl.js        # 日成交量 vs 盈亏回测
├── backtest-10k.js                  # 10k 样本回测
└── test-cycle.js                    # 单次周期空跑测试
docs/
└── ARCHITECTURE.md
logs/
├── signals.jsonl
├── trades.jsonl
├── settlements.jsonl
├── session.jsonl
├── session-state.json
├── stats-state.json
├── pending-bet.json
└── martingale-state.json
```

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### K 线 / 信号

| 变量 | 默认 | 说明 |
|------|------|------|
| `OHLCV_EXCHANGE` | okx | K 线主交易所（国内建议 okx） |
| `OHLCV_MARKET_TYPE` | swap | `swap`=OKX USDT 永续；`spot`=现货 |
| `TRADING_SYMBOL` | BTC/USDT | Polymarket slug + 结算标的（可与 OHLCV 分离） |
| `SIGNAL_DELAY_MS` | 10000 | 5m 边界后延迟再拉 K 线 |

### 结算

| 变量 | 默认 | 说明 |
|------|------|------|
| `SETTLE_SOURCE` | okx | `okx` 永续 K 线 / `chainlink` RTDS oracle |
| `CHAINLINK_SETTLE_BUFFER_MS` | 3000 | 周期结束后取结算价前的等待 |
| `CHAINLINK_SAFETY_INTERVAL_MS` | 60000 | 补结算安全网间隔 |

### 活跃度探测

| 变量 | 默认 | 说明 |
|------|------|------|
| `SESSION_GATE_ENABLED` | true | false = 跳过探测，常开 |
| `SESSION_CANDLE_LIMIT` | 12 | 评估时拉取 5m K 线根数 |
| `DYNAMIC_THRESHOLD_ENABLED` | true | 动态触发线（活跃度 → 阈值） |
| `ACTIVITY_WINDOW_BARS` | 12 | 活跃度统计窗口（12×5m=1h） |
| `ACTIVITY_PROBE_USDT_MIN` | 30000000 | 探测线：单根成交额 ≥ 此值计为达标 |
| `ACTIVITY_MIN_HITS` | 11 | 近窗内达标根数 ≥ 此值才开单 |
| `ACTIVITY_TIER_BETS` | 3,3,…,6,9,15,24 | 12 档首注（highTierOnly） |

### 下单 / 成交

| 变量 | 默认 | 说明 |
|------|------|------|
| `ORDER_TYPE` | GTC | `GTC` 限价 / `FOK` 市价 |
| `LIMIT_PRICE_OFFSET_TICKS` | 0 | 限价相对 best ask 的 tick 偏移 |
| `FILL_SYNC_POLL_MS` | 500 | 提交后 getOrder 轮询间隔 |
| `FILL_SYNC_MAX_WAIT_MS` | 8000 | 短时轮询最长等待 |
| `ORDER_FILL_ATTEMPTS` | 8 | FOK 未成交重试次数 |

### 马丁 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 3 | 档 1 基准 / 未设 ACTIVITY_TIER_BETS 时的递增生成的起点 |
| `MARTINGALE_MULTIPLIER` | 2 | 连亏翻倍 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏 4 次触发停机并重置 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限 |
| `MAX_BET_USD` | 10000 | 单笔下注上限 |
| `ORDER_PRICE_CAP` | 0.95 | YES/NO 对称封顶；`0`=不限制 |
| `DRY_RUN` | false | true = 模拟下单 |

Polymarket / 钱包 / Telegram 变量见 `.env.example`。

---

## 运行逻辑

```
每 5m 周期
  │
  ├─ CCXT 拉 OKX 永续 5m K 线（探测开启时扩展至 SESSION_CANDLE_LIMIT 根）
  ├─ 结算上一笔 pending-bet（OKX K 线 或 Chainlink）
  ├─ 活跃度探测：近窗 hits ≥ 11（方案 A）？
  │     └─ 未达标 → 本周期结束（不新开单）
  ├─ K[-1] 形态 → S1/S2/NONE（单 K 线跟随）
  ├─ 风控：日亏损上限 / 马丁停机 / 余额
  ├─ Gamma 发现 Polymarket 5m 盘口 → CLOB 下单
  └─ 下一周期结算 → 马丁 + 统计更新
```

- **活跃度未达标**：本周期不新开单，仍结算 pending。
- **无信号**或**风控拦截**：本周期不下单，马丁不变。
- **连亏 4 次**：下一周期跳过并重置为基础注。
- **赢一局**：马丁重置为 `TRADE_BUDGET_USD`。
- GTC 未成交不计入马丁；FOK 流动性不足会重试后跳过。

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 正式运行 |
| `npm run dry` | 本地空跑 |
| `npm run pm2:dry` | PM2 模拟盘（方案 A，`DRY_RUN=true`） |
| `npm run pm2:start` | PM2 实盘 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 API 凭证 |
| `node scripts/check-env.js` | 检查配置 |
| `DRY_RUN=true node scripts/test-cycle.js` | 单次周期测试 |
| `node scripts/backtest-session-gate-v2.js` | 活跃度探测回测 |
| `node scripts/backtest-daily-vol-pnl.js --days=365` | 日成交量 vs 盈亏回测 |
| `node scripts/backtest-10k.js` | 10k 样本策略回测 |

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。服务器模拟盘：

```bash
cp .env.example .env    # DRY_RUN=true，无需私钥
npm install
npm run pm2:dry
pm2 logs V3
```

### 多账号

```bash
git clone <仓库> ~/PMfanz2 && cd ~/PMfanz2 && npm install
cp .env.example .env
pm2 start src/index.js --name pmfanz2 --time
```

---

## 注意事项

- 钱包需有足够 **pUSD**（≥ `MIN_BALANCE_USD`）
- 国内服务器：`OHLCV_EXCHANGE=okx`；需能访问 `https://gamma-api.polymarket.com` 与 `https://clob.polymarket.com`
- 默认 `SETTLE_SOURCE=okx`，无需 Chainlink RTDS；若改 `chainlink`，需能访问 `wss://ws-live-data.polymarket.com`
- 首次部署建议 `DRY_RUN=true` 空跑，确认 K 线拉取与活跃度日志正常
- 活跃度探测默认开启；若需常开，设 `SESSION_GATE_ENABLED=false`
- 服务器 `.env` 若仍保留 `VOL_COMPRESS_*`、`VOL_SPIKE_*`、`RV_RATIO_MAX` 等旧版变量，当前代码不再读取；可删除或置空
