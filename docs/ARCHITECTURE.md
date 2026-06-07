# 架构与运行逻辑

> 本文档描述 PMfanz 当前实现（2026-06），涵盖信号、下单、成交监视、Chainlink 结算全链路。  
> 配置项详见 [.env.example](../.env.example)，部署见 [DEPLOY.md](../DEPLOY.md)。

---

## 1. 设计原则

| 模块 | 数据源 | 用途 |
|------|--------|------|
| **信号** | CCXT 交易所 5m OHLCV（OKX → Bybit → Binance） | S1/S2 反转延续规则 |
| **下单** | Polymarket CLOB V2 | GTC 限价 / FOK 市价 |
| **结算** | Polymarket RTDS Chainlink | 官方 oracle：`close >= target → UP` |
| **交叉校验** | 交易所 K 线 vs Chainlink | 仅 WARN / Telegram，不影响结算 |

信号与结算** intentionally 分离**：策略基于交易所 K 线形态；Polymarket 5m 盘口按 Chainlink 价格 payout，结算必须对齐 oracle。

---

## 2. 整体数据流

```
┌─────────────────────────────────────────────────────────────────┐
│ 启动                                                            │
│  startRtdsBuffer(symbol)  →  Chainlink tick 缓冲                   │
│  startChainlinkSettler()  →  结算安全网（60s 轮询）              │
└─────────────────────────────────────────────────────────────────┘
                              │
        UTC 5m 边界 + SIGNAL_DELAY_MS
                              ▼
┌──────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│ CCXT fetchOHLCV  │───▶│ S1/S2 信号       │───▶│ 波动率下限检查    │
│ (已收盘 K 线)     │    │ reversalCont.    │    │ MIN_RV_* (1m rv)  │
└──────────────────┘    └──────────────────┘    └────────┬────────┘
                                                         │ rv 足够
                                                         ▼
                                                ┌─────────────────┐
                                                │ Gamma 市场发现   │
                                                │ {base}-updown-* │
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
           Chainlink 结算
           (confirmOrderFilled 前置校验)
                    ▼
           martingale.onSettled + stats.recordSettlement
           + settlements.jsonl → stats 启动回填
```

---

## 3. 调度时序（每 5 分钟）

| 时刻 | 动作 |
|------|------|
| T = 边界 + `SIGNAL_DELAY_MS` | 拉 CCXT K 线；若有 pending bet 尝试补结算 |
| 同上 | `buildSignal(K[-2], K[-1])` |
| 有信号 | 拉 1m K 线 → 计算 rv_1m/5m/15m → **低于 MIN_RV_* 则跳过** |
| rv 通过 | Gamma 找当前 5m 盘口 → 马丁取注 → CLOB 下单 |
| 成交 / 挂单 | 见 §4 |
| T = 周期结束 + buffer | Chainlink 定时结算 |
| 下一周期开始 | 结算安全网 + OHLCV 交叉校验 |

---

## 4. 下单与成交

### 4.1 订单类型

| `ORDER_TYPE` | 模式 | API | 行为 |
|--------------|------|-----|------|
| `GTC`（推荐） | 限价 | `createAndPostOrder` | best ask + offset 挂单 |
| `FOK` | 市价 | `createAndPostMarketOrder` | 全成或撤销，失败重试 |

限价定价：`getOrderBook` → 最优卖价 + `LIMIT_PRICE_OFFSET_TICKS × tickSize`。

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
- 成交后 → `registerPendingBet` + Telegram + 调度 Chainlink 结算

### 4.3 下单结果 → 主流程

| 结果 | pending bet | 马丁 | Telegram |
|------|-------------|------|----------|
| `usdcSpent > 0` | 立即写入 | 等结算 | 开单成交 + 波动率 + 统计 |
| `resting`（GTC 挂单） | 等补偿轮询 | 等成交后 | 限价挂单 + 波动率 + 统计 |
| rv 过低 / 跳过 | 无 | **不变** | 波动率过低 + 统计 |
| `skipped` | 无 | **不变** | 无 |
| 周期内未成交 | 无 | **不变** | 无 |

### 4.4 FOK 重试

- 最多 `ORDER_FILL_ATTEMPTS` 次，间隔 `ORDER_RETRY_DELAY_MS`
- 必须 `usdcSpent > 0` 才算成功（fillSync 校验）

---

## 5. Chainlink 结算

### 5.1 规则（Polymarket 官方）

```
目标价 target = 周期开始 Chainlink 价
  （周期开始后 OPEN_WINDOW_MS 内首 tick，否则 <= 周期开始的最近 tick）

收盘价 close   = 周期结束时刻 <= endMs 的最近 Chainlink tick

winningOutcome = close >= target ? UP : DOWN

won = (bet signal == winningOutcome)
```

注意：与交易所 K 线 `close vs open` **不同**；`close === target` 时 Chainlink 判 **UP 赢**（不是 DOJI）。

### 5.2 结算触发

1. **定时器**：下单成功后 `scheduleChainlinkSettlement`，在 `cycleEnd + CHAINLINK_SETTLE_BUFFER_MS` 触发
2. **下一周期**：`trySettlePending` 补结算
3. **安全网**：每 `CHAINLINK_SAFETY_INTERVAL_MS` 检查到期 pending

### 5.3 结算前验成交

`confirmOrderFilled`：对 live 订单再查 `getOrder`，`usdcSpent <= 0` 则 void pending，**不更新马丁**。

### 5.4 交叉校验

结算时若已有同窗口 CCXT K 线，对比：

- 交易所方向：`close > open → UP`，`close < open → DOWN`，相等 → DOJI
- 与 Chainlink `winningOutcome` 不一致 → WARN + Telegram ⚠️

---

## 5.5 波动率风控

参照 Polymarket-Martin-Bot，对**独立 1m K 线**（`VOLATILITY_BAR_TIMEFRAME`）计算 log return 样本标准差 rv：

```
rv = sampleStd( ln(close_i / close_{i-1}) )   # 窗口内逐 bar
```

| 窗口 | 1m K 线下 bar 数 | 时间跨度 |
|------|-----------------|----------|
| rv_1m | 2 | ~1 分钟 |
| rv_5m | 5 | ~5 分钟 |
| rv_15m | 15 | ~15 分钟 |

**拦截规则**（`MIN_RV_* > 0` 时启用；旧 env 名 `MAX_RV_*` 仍兼容，语义为下限）：

```
min > 0 且 (rv == null 或 rv < min) → 跳过本周期，Telegram 通知
```

策略假设：**波动率越大越好**，横盘/低波动时不交易。未配置下限（全为 0）时仍拉 rv 并展示在 Telegram，但不拦截。

实现：`src/utils/volatility.js`；有信号后、市场发现前执行。

---

## 5.6 盈亏统计

| 指标 | 说明 |
|------|------|
| 累计 / 今日盈亏 | 赢：`投入/成交价 - 投入`；输：`-投入` |
| 胜率 | 累计与今日分别统计 |
| 止损次数 | 马丁连亏触发时 +1；**今日按北京时间 0 点切日** |

- 持久化：`logs/stats-state.json`
- **启动回填**：从 `logs/settlements.jsonl`（含 `.1`~`.5` 轮转）按 `cycleStartTs` 去重重建，避免重启归零
- 展示：结算 / 开单 / 波动率跳过 Telegram 底部统计块；`settlements.jsonl` / `heartbeat.json` / 主日志含 `stats` 字段

实现：`src/stats/manager.js`

---

## 6. 持久化文件

| 文件 | 内容 |
|------|------|
| `logs/signals.jsonl` | 每轮信号（含 NONE） |
| `logs/trades.jsonl` | 下单记录（filled / resting / unfilled） |
| `logs/settlements.jsonl` | Chainlink 结算（含 pnlUsd、martingaleHalted、stats） |
| `logs/stats-state.json` | 盈亏 / 胜率 / 止损快照（启动时由 settlements 回填） |
| `logs/pending-bet.json` | 待结算注单（含 targetPrice、orderId、entryPrice） |
| `logs/martingale-state.json` | 马丁状态 |
| `logs/daily-loss.json` | 当日 UTC 累计亏损 |
| `logs/heartbeat.json` | 最近一轮状态快照 |

**pending-bet.json 结构：**

```json
{
  "cycleStartTs": 1717413300000,
  "signal": "UP",
  "actualBet": 4.0,
  "targetPrice": 67523.45,
  "orderId": "0x...",
  "limitPrice": 0.52,
  "entryPrice": 0.47
}
```

**Polymarket slug**（`src/market/polymarket.js`）：

```
{base}-updown-{timeframe}-{windowStartUnixSec}
```

`base` 取自 `TRADING_SYMBOL` 前半段小写（如 `ETH/USDT` → `eth-updown-5m-1780758600`）。

---

## 7. 模块索引

| 路径 | 职责 |
|------|------|
| `src/index.js` | UTC 调度、pending bet、结算/TG 编排 |
| `src/collector/binance.js` | CCXT OHLCV（信号 5m + 波动率 1m） |
| `src/collector/chainlink.js` | RTDS WebSocket；支持 BTC/ETH/SOL/BNB |
| `src/strategy/reversalContinuation.js` | S1/S2 纯函数 |
| `src/market/polymarket.js` | Gamma 5m 盘口；`buildMarketSlug()` |
| `src/stats/manager.js` | 盈亏统计、settlements 回填、Telegram 块 |
| `src/utils/volatility.js` | rv 计算、MIN_RV 下限风控 |
| `src/trader/executor.js` | CLOB 下单、GTC/FOK 分支 |
| `src/trader/fillSync.js` | 成交解析与短时轮询 |
| `src/trader/restingFillWatcher.js` | GTC 周期内补偿轮询 |
| `src/trader/chainlinkSettle.js` | 结算调度、交叉校验 helper |
| `src/martingale/manager.js` | 马丁状态机 |
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
| v2.5 | 可配置 `TRADING_SYMBOL`；盈亏统计 + settlements 回填；波动率下限风控 + Telegram |

**实盘最小 `.env`：**

```env
DRY_RUN=false
POLY_PRIVATE_KEY_ENCRYPTED=...
POLY_KEY_PASSWORD=...
OHLCV_EXCHANGE=okx
ORDER_TYPE=GTC
```

`POLY_API_KEY` / `SECRET` / `PASSPHRASE` 可选；留空时首次连接 CLOB 自动 `createOrDeriveApiKey()`。预写入可加快启动。

---

## 10. 推荐配置（生产）

```env
ORDER_TYPE=GTC
OHLCV_EXCHANGE=okx
TRADING_SYMBOL=BTC/USDT
FILL_SYNC_POLL_MS=500
FILL_SYNC_MAX_WAIT_MS=8000
CHAINLINK_SETTLE_BUFFER_MS=3000
# 波动率下限（0=关闭）；ETH 等需确保 Polymarket 有对应 5m 盘口
# MIN_RV_1M=0.00015
DRY_RUN=false
```

首次部署：`DRY_RUN=true` 空跑 ≥1 小时，确认日志出现 `[chainlink] RTDS buffer ready` 且无 `OHLCV fetch failed`。
