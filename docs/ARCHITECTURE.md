# 架构与运行逻辑

> 神奇九转 · 多标的 × 多周期 · 共用账本。  
> 配置见 [.env.example](../.env.example)，部署见 [DEPLOY.md](../DEPLOY.md)，总览见 [README.md](../README.md)。

---

## 1. 设计原则

| 模块 | 数据源 | 用途 |
|------|--------|------|
| **信号** | CCXT 交易所 OHLCV | 神奇九转 Setup9 → JZ_UP / JZ_DOWN |
| **状态** | `logs/jz-state-{instance}.json` | `idle` / `in_chain` + 锁定方向 |
| **账本** | `logs/bankroll-state-jz.json` | 全标的×周期共用 P / N / 补队列（文件锁） |
| **下单** | Polymarket CLOB V2 | GTC 限价 / FOK 市价 |
| **结算** | OKX 永续或 Chainlink RTDS | `close >= open/target → UP` |

---

## 2. 进程模型

PM2：`TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` → 多进程（例 `V3-btc-5m`）。

每进程注入：`STRATEGY=jz`、`BANKROLL_SCOPE=jz`、`MARTINGALE_MAX_LOSSES=2`。

| 隔离 | 共用 |
|------|------|
| pending / jz 相位 / 马丁连亏 / stats / 日志 | `bankroll-state-jz.json`（P/N/补队列） |

---

## 3. 信号

`src/strategy/magicNineTurns.js` + `jzState.js`（经 `activeStrategy.js`）：

1. Buy/Sell Setup 满 9 → 入场并 `in_chain`
2. 赢 → `idle`
3. 输 → 同向锁单 1 次；再结算后 `idle`（halt）

---

## 4. 账本

`src/martingale/bankroll.js`：多进程 `withLock` 串行读写同一文件。

目标线 `P + N × step`；gap > 0 时走补队列动态仓位。

---

## 5. 关键文件

| 文件 | 说明 |
|------|------|
| `src/index.js` | 调度：信号 / 下单 / 结算 / TG |
| `src/strategy/activeStrategy.js` | 九转门面 |
| `src/strategy/magicNineTurns.js` | Setup 检测 |
| `src/strategy/jzState.js` | 相位状态机 |
| `src/martingale/bankroll.js` | 共用账本 |
| `scripts/lib/buildEcosystemApps.cjs` | PM2 矩阵 |
| `scripts/backtest-jz-global-shared.js` | 全局共用账本回测 |
| `scripts/backtest-jz-multitf-shared.js` | 同标的多周期共用账本回测 |
