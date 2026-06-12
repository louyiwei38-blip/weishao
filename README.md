# Polymarket Reversal Continuation Bot

**PRD v2.4+ · xw_MEIKONG** · BTC/USDT 5m · **低波动反转** · 缩量窗会话门控 · Martingale 4-loss stop · CLOB V2 · OKX 结算 / Chainlink 可选 · GTC 限价

Polymarket 5 分钟涨跌盘口自动交易机器人：OKX 永续 5m K 线形态产生 S1/S2 信号，**动态缩量窗**决定何时跑策略，CLOB 限价/市价下单，OKX K 线或 Chainlink oracle 结算，马丁格尔管理仓位。

> 详细架构见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（信号 / 门控 / 下单 / 成交监视 / 结算全链路）

---

## 策略

基于**两根已收盘**的 5m K 线（`K[-2]` 上上根、`K[-1]` 上一根），**固定低波动反转**模式：

| 条件 | 信号 | 操作 |
|------|------|------|
| 上上根阳 + 上一根阴 | **S1** UP | 买涨（YES token） |
| 上上根阴 + 上一根阳 | **S2** DOWN | 买跌（NO token） |
| 同向 / 十字线 | NONE | 跳过 |

**语义：** 出现阳→阴或阴→阳反转后，押注**下一根 5m K 线**反向（均值回归）。

- **信号 K 线**：CCXT 拉取 OKX **USDT 永续** 5m OHLCV（`OHLCV_EXCHANGE=okx`，`OHLCV_MARKET_TYPE=swap`）。
- **Polymarket 盘口**：`TRADING_SYMBOL` 驱动 slug（如 `btc-updown-5m-{windowStartUnix}`）。
- **结算**：默认 `SETTLE_SOURCE=okx`（永续 5m K 线 `close vs open`）；设 `chainlink` 时走 RTDS oracle。
- **下单**：推荐 `ORDER_TYPE=GTC` 限价；可改 `FOK` 市价。
- **波动率**：独立拉 1m K 线计算 rv，**仅写入日志与 Telegram**，不改变信号方向。

---

## 会话门控（缩量窗）

默认 **开启**（`SESSION_GATE_ENABLED=true`）。门控关闭时等同常开。

每根 5m K 线收盘后，用该根 **USDT 成交额**（`volume × close`）与固定触发线比较：

```
本根成交额 ≤ 3M USDT  →  开门 21 分钟（VOLUME_BURST_MINUTES）
再次触发               →  从当前时刻刷新，不叠加
窗口内                 →  tradeAllowed = true，执行 S1/S2
窗口外                 →  IDLE，本周期不新开单（仍结算 pending 注单）
```

### 固定触发线

默认 **`DYNAMIC_THRESHOLD_ENABLED=false`**，触发线 **`BAR_VOLUME_USDT_MIN=3M`**（90 天回测门控组 ROI 最高 2.9%）。

若改回动态门控，设 `DYNAMIC_THRESHOLD_ENABLED=true` 并配置 `BAR_VOLUME_USDT_MIN_DYNAMIC` / `MAX_DYNAMIC` / `ACTIVITY_PROBE_USDT_MIN`。

> 定时常开（宏观日历 / 美股时段）已从生产门控移除，**仅缩量窗**。

日志：`logs/session.jsonl`、`logs/session-state.json`（含 `volumeBurstUntilMs` 持久化）。

---

## 快速开始

```bash
npm install
cp .env.example .env
node scripts/check-env.js
npm run dry
npm start
```

**Node.js ≥ 18**。首次部署建议 `DRY_RUN=true` 空跑 ≥1 小时。

---

## 项目结构

```
src/
├── index.js
├── session/sessionGate.js           # 缩量窗门控
├── strategy/reversalContinuation.js # S1/S2 低波反转
├── trader/ …                        # 下单 / 结算
scripts/
├── backtest-session-gate-v2.js      # 缩量窗 + 低波反转回测
└── test-cycle.js
```

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### 会话门控

| 变量 | 默认 | 说明 |
|------|------|------|
| `SESSION_GATE_ENABLED` | true | false = 常开 |
| `DYNAMIC_THRESHOLD_ENABLED` | false | true = 动态 min..max |
| `BAR_VOLUME_USDT_MIN` | 3000000 | 固定触发线（≤ 即开门） |
| `VOLUME_BURST_MINUTES` | 21 | 触发后开门时长 |

### 马丁 / 风控 / 下单

见 `.env.example`（`TRADE_BUDGET_USD`、`MARTINGALE_MAX_LOSSES`、`ORDER_TYPE` 等）。

---

## 运行逻辑

```
每 5m → 拉 K 线 → 结算 pending → 缩量窗评估 → S1/S2 低波反转 → 风控 → CLOB 下单 → 结算 → 马丁
```

- **门控 IDLE**：不新开单，仍结算 pending。
- **无信号 / 风控拦截**：马丁不变。
- GTC 未成交不计入马丁。

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm start` / `npm run dry` | 正式 / 空跑 |
| `DRY_RUN=true node scripts/test-cycle.js` | 单次周期测试 |
| `node scripts/backtest-session-gate-v2.js --days=365` | 缩量窗回测 |
| `node scripts/backtest-session-gate-v2.js --days=365 --sweep-volume` | 阈值扫参 |

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。

---

## 注意事项

- 钱包需有足够 **pUSD**
- 国内服务器：`OHLCV_EXCHANGE=okx`
- 默认 `SETTLE_SOURCE=okx`，不依赖 RTDS
- 服务器 `.env` 若仍保留旧 `VOL_COMPRESS_*`、定时常开变量，生产已不再读取
- 缩量触发线可在 `.env` 长期观察后微调
