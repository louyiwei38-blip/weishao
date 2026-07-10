# 架构与运行逻辑

> 本文档描述维加斯通道 1h Polymarket 机器人实现，涵盖信号、下单、成交监视、结算全链路。  
> 配置项详见 [.env.example](../.env.example)，部署见 [DEPLOY.md](../DEPLOY.md)。

---

## 1. 设计原则

| 模块 | 数据源 | 用途 |
|------|--------|------|
| **信号** | CCXT 交易所 1h OHLCV | EMA144/169 维加斯通道穿越 → VG_UP / VG_DOWN |
| **状态** | `logs/vegas-state.json` | `need_outside` / `armed` / `in_chain` + 锁定方向 |
| **下单** | Polymarket CLOB V2 | GTC 限价 / FOK 市价；超阈值按 `ORDER_PRICE_CAP` 限价 |
| **结算** | OKX 永续 1h（默认）或 Chainlink RTDS | `close >= open/target → UP` |
| **交叉校验** | 交易所 K 线 vs Chainlink | 仅 WARN / Telegram，不影响结算 |

信号与结算** intentionally 分离**：策略基于交易所 K 线通道；Polymarket 1h 盘口按 Chainlink 价格 payout 时，结算必须对齐 oracle。

---

## 2. 整体数据流

```
┌─────────────────────────────────────────────────────────────────┐
│ 启动                                                            │
│  startRtdsBuffer(symbol)  →  Chainlink tick 缓冲（可选）         │
│  startChainlinkSettler()  →  结算安全网（60s 轮询）              │
│  vegasState.init()        →  need_outside / armed / in_chain    │
└─────────────────────────────────────────────────────────────────┘
                              │
        UTC 1h 边界 + SIGNAL_DELAY_MS
                              ▼
┌──────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ CCXT fetchOHLCV  │    │ vegas 状态机      │    │ VG_UP / VG_DOWN │
│ (已收盘 1h K)    │───▶│ 或 MG_CONT 续单   │───▶│ / NONE          │
└──────────────────┘    └──────────────────┘    └────────┬────────┘
                                                         │ 有信号
                                                         ▼
                                                ┌─────────────────┐
                                                │ Gamma 市场发现   │
                                                │ {base}-updown-1h│
                                                └────────┬────────┘
                                                         ▼
                                                ┌─────────────────┐
                                                │ 价格封顶检查     │
                                                │ ORDER_PRICE_CAP │
                                                └────────┬────────┘
                                                         ▼
                                                ┌──────────────────┐
                                                │ CLOB 下单         │
                                                │ GTC / FOK        │
                                                └────────┬─────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
     usdcSpent>0       resting(GTC)      skipped
     立即 pending      补偿轮询           马丁不变
           │                 │
           └────────┬────────┘
                    ▼
           pending-bet.json
                    │
     周期结束 + CHAINLINK_SETTLE_BUFFER_MS
                    ▼
           OKX / Chainlink 结算
           (confirmOrderFilled 前置校验)
                    ▼
           martingale.onSettled + vegasState.onSettled
           + settlements.jsonl → stats 启动回填
```

---

## 3. 调度时序（每 1 小时）

| 时刻 | 动作 |
|------|------|
| T = 边界 + `SIGNAL_DELAY_MS` | 拉 CCXT 1h K 线；若有 pending bet 尝试补结算 |
| 同上 | `vegasState.resolveSignal(candles)` |
| 有信号 | Gamma 找当前 1h 盘口 → **价格封顶** → 马丁取注 → CLOB 下单 |
| 成交 / 挂单 | 见 §4 |
| T = 周期结束 + buffer | 定时结算 |
| 下一周期开始 | 结算安全网 + OHLCV 交叉校验 |

### 3.1 维加斯信号规则

| 条件 | 信号 |
|------|------|
| K[-2] 实体完全在通道上方 + K[-1] `low ≤ upper` | UP（VG_UP） |
| K[-2] 实体完全在通道下方 + K[-1] `high ≥ lower` | DOWN（VG_DOWN） |

通道：`upper = max(EMA144, EMA169)`，`lower = min(EMA144, EMA169)`。

### 3.2 状态机

| phase | 行为 |
|-------|------|
| `need_outside` | 仅等待实体在通道外的已收盘 K → `armed` |
| `armed` | 评估穿越；命中则锁定方向 → `in_chain` 并下首注 |
| `in_chain` | 忽略新穿越；每小时同向 `MG_CONT` 续单 |

赢或连亏 5 次止损 → `need_outside`（须再等通道外实体后才能新开链路）。

---

## 4. 下单与成交

### 4.1 订单类型

| `ORDER_TYPE` | 模式 | API | 行为 |
|--------------|------|-----|------|
| `GTC`（推荐） | 限价 | `createAndPostOrder` | best ask + offset 挂单 |
| `FOK` | 市价 | `createAndPostMarketOrder` | 全成或撤销，失败重试 |

限价定价：`getOrderBook` → 最优卖价 + `LIMIT_PRICE_OFFSET_TICKS × tickSize`。

**超阈值封顶**：买 YES 或 NO 时，若对应盘口价 > `ORDER_PRICE_CAP`，强制按阈值挂限价单（`ORDER_TYPE=FOK` 时亦改用限价）。

### 4.2 成交检测（三层）

参考 Polymarket-Martin-Bot 的 `fillSync` + `restingFillWatcher`：

**Layer 1 — 提交响应解析（`fillSync.deriveFillFromPost`）**

- 读 `makingAmount`（USDC）、`takingAmount`（shares）
- GTC：有 `orderID` 且无 error → 挂单成功（resting），不算失败

**Layer 2 — 短时轮询（`FILL_SYNC_MAX_WAIT_MS`，默认 8s）**

- 轮询 `getOrder(orderId)`，间隔 `FILL_SYNC_POLL_MS`（500ms）
- 有 `size_matched > 0` → 已成交（含部分成交）

**Layer 3 — 周期内补偿监视（仅 GTC resting）**

- 短时轮询仍无成交 → `restingFillWatcher` 后台继续 poll
- 直到 **周期结束** 或成交
- 成交后 → `registerPendingBet` + Telegram + 调度结算

### 4.3 下单结果 → 主流程

| 结果 | pending bet | 马丁 | Telegram |
|------|-------------|------|----------|
| `usdcSpent > 0` | 立即写入 | 等结算 | 开单成交 + 统计 |
| `resting`（GTC 挂单） | 等补偿轮询 | 等成交后 | 限价挂单 + 统计 |
| `skipped` | 无 | **不变**（`in_chain` 方向保持） | 无 |
| 周期内未成交 | 无 | **不变** | 无 |

### 4.4 FOK 重试

- 最多 `ORDER_FILL_ATTEMPTS` 次，间隔 `ORDER_RETRY_DELAY_MS`
- 必须 `usdcSpent > 0` 才算成功（fillSync 校验）

---

## 5. 结算

### 5.1 规则（Polymarket / OKX）

**OKX（默认）：**

```
winningOutcome = close >= open ? UP : DOWN
won = (bet signal == winningOutcome)
```

**Chainlink：**

```
目标价 target = 周期开始 Chainlink 价
收盘价 close   = 周期结束时刻 <= endMs 的最近 Chainlink tick
winningOutcome = close >= target ? UP : DOWN
won = (bet signal == winningOutcome)
```

### 5.2 结算触发

1. **定时器**：下单成功后 `scheduleChainlinkSettlement`，在 `cycleEnd + CHAINLINK_SETTLE_BUFFER_MS` 触发
2. **下一周期**：`trySettlePending` 补结算
3. **安全网**：每 `CHAINLINK_SAFETY_INTERVAL_MS` 检查到期 pending

### 5.3 结算前验成交

`confirmOrderFilled`：对 live 订单再查 `getOrder`，`usdcSpent <= 0` 则 void pending，**不更新马丁 / vegas**。

### 5.4 交叉校验

结算时若已有同窗口 CCXT K 线，对比交易所方向与 Chainlink `winningOutcome`；不一致 → WARN + Telegram ⚠️。

---

## 5.6 价格封顶

`ORDER_PRICE_CAP`（默认 `0.95`；`0` = 不限制；旧名 `YES_PRICE_MAX` 仍兼容）：

| 方向 | 判断 | 盘口价 ≤ 阈值 | 盘口价 > 阈值 |
|------|------|---------------|---------------|
| 买涨 UP | YES 价 | 正常下单 | 按阈值挂限价 |
| 买跌 DOWN | NO 价 | 正常下单 | 按阈值挂限价 |

**不因价格跳过本周期**。实现：`src/market/polymarket.js` → `resolveOrderPricePolicy()`。

---

## 5.7 盈亏统计

| 指标 | 说明 |
|------|------|
| 累计 / 今日盈亏 | 赢：`投入/成交价 - 投入`；输：`-投入` |
| 胜率 | 累计与今日分别统计 |
| 止损次数 | 马丁连亏触发时 +1；**今日按北京时间 0 点切日** |

- 持久化：`logs/stats-state.json`
- **启动回填**：从 `logs/settlements.jsonl`（含 `.1`~`.5` 轮转）按 `cycleStartTs` 去重重建
- 展示：结算 / 开单 / 无信号 Telegram 均附带统计块

实现：`src/stats/manager.js`

---

## 6. 持久化文件

| 文件 | 内容 |
|------|------|
| `logs/signals.jsonl` | 每轮信号（含 NONE、phase、bands） |
| `logs/trades.jsonl` | 下单记录（filled / resting / unfilled） |
| `logs/settlements.jsonl` | 结算（含 pnlUsd、martingaleHalted、stats） |
| `logs/stats-state.json` | 盈亏 / 胜率 / 止损快照 |
| `logs/pending-bet.json` | 待结算注单 |
| `logs/martingale-state.json` | 马丁状态 |
| `logs/vegas-state.json` | 维加斯相位 + 锁定方向 |
| `logs/daily-loss.json` | 当日 UTC 累计亏损 |
| `logs/heartbeat.json` | 最近一轮状态快照 |

**Polymarket slug**（`src/market/polymarket.js`）：

```
{base}-updown-{timeframe}-{windowStartUnixSec}
```

例：`BTC/USDT` + `1h` → `btc-updown-1h-1780758600`。

---

## 7. 模块索引

| 路径 | 职责 |
|------|------|
| `src/index.js` | UTC 周期调度、pending bet、结算/TG 编排（`BOT_INSTANCE` 隔离状态） |
| `src/utils/instancePaths.js` | 多周期并行时的日志/状态文件后缀 |
| `src/collector/binance.js` | CCXT OHLCV（信号 1h） |
| `src/collector/chainlink.js` | RTDS WebSocket；支持 BTC/ETH/SOL/BNB |
| `src/strategy/vegasChannel.js` | EMA144/169、实体外、影线入、穿越判定 |
| `src/strategy/vegasState.js` | need_outside / armed / in_chain 状态机 |
| `src/strategy/reversalContinuation.js` | 旧 5m 策略（回测脚本用） |
| `src/market/polymarket.js` | Gamma 盘口；`resolveOrderPricePolicy()` |
| `src/stats/manager.js` | 盈亏统计、settlements 回填、Telegram 块 |
| `src/trader/executor.js` | CLOB 下单、GTC/FOK 分支、价格封顶限价 |
| `src/trader/fillSync.js` | 成交解析与短时轮询 |
| `src/trader/restingFillWatcher.js` | GTC 周期内补偿轮询 |
| `src/trader/chainlinkSettle.js` | 结算调度、交叉校验 helper |
| `src/martingale/manager.js` | 马丁状态机（同向 ×3；5 连亏立即重置） |
| `src/utils/websocket.js` | RTDS WebSocket（native / ws 包） |

---

## 8. 网络依赖

| 端点 | 用途 |
|------|------|
| `wss://ws-live-data.polymarket.com` | Chainlink RTDS（需 `ws` 包，Node 18+） |
| `https://gamma-api.polymarket.com` | 市场发现 |
| `https://clob.polymarket.com` | 下单、余额、getOrder |
| OKX / Bybit / Binance REST | CCXT OHLCV |

---

## 9. 变更历史（摘要）

| 版本 | 变更 |
|------|------|
| v2.2 初版 | CCXT 信号 + 交易所 K 线结算 |
| v2.3 | Chainlink RTDS 结算；CCXT 仅信号/校验 |
| v2.4 | GTC 限价 + fillSync + restingFillWatcher；结算前验成交 |
| v2.5 | 可配置 `TRADING_SYMBOL`；盈亏统计 + settlements 回填 |
| v2.6 | 波动率择向策略；买 YES/NO 对称价格封顶 `ORDER_PRICE_CAP` |
| v3.0 | **1h 维加斯通道穿越入场** + 同向马丁；替换 5m 反转延续实盘信号 |

**实盘最小 `.env`：**

```env
DRY_RUN=false
POLY_PRIVATE_KEY_ENCRYPTED=...
POLY_KEY_PASSWORD=...
OHLCV_EXCHANGE=okx
ORDER_TYPE=GTC
```

`POLY_API_KEY` / `SECRET` / `PASSPHRASE` 可选；留空时首次连接 CLOB 自动 `createOrDeriveApiKey()`。

---

## 10. 推荐配置（生产）

```env
ORDER_TYPE=GTC
OHLCV_EXCHANGE=okx
OHLCV_MARKET_TYPE=swap
TRADING_SYMBOL=BTC/USDT
CANDLE_TIMEFRAME=1h
MARKET_CYCLE_MINUTES=60
CANDLE_FETCH_LIMIT=200
SETTLE_SOURCE=okx
FILL_SYNC_POLL_MS=500
FILL_SYNC_MAX_WAIT_MS=8000
ORDER_PRICE_CAP=0.95
DRY_RUN=false
```

首次部署：`DRY_RUN=true` 空跑确认能拉满 1h K、算出 EMA 带，且 slug 形如 `btc-updown-1h-*`。
