# Polymarket Reversal Continuation Bot

**PRD v2.4+** · BTC/USDT 5m · 高波动延续 · 会话启停 · Martingale 4-loss stop · CLOB V2 · Chainlink 结算 · GTC 限价

Polymarket 5 分钟涨跌盘口自动交易机器人：CCXT 5m K 线形态产生信号，**压缩 ∧ 异动**会话评估决定是否跑脚本，CLOB 限价/市价下单，Chainlink oracle 结算，马丁格尔管理仓位。

> 详细架构见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**（信号 / 下单 / 成交监视 / 结算全链路）

---

## 策略

基于**两根已收盘**的 5m K 线（`K[-2]` 上上根、`K[-1]` 上一根），**固定高波动延续**模式：

| 条件 | 信号 | 操作 |
|------|------|------|
| 上上根阳 + 上一根阴 | **S1** DOWN | 买跌（NO token） |
| 上上根阴 + 上一根阳 | **S2** UP | 买涨（YES token） |
| 同向 / 十字线 | NONE | 跳过 |

**语义：** 出现阳→阴或阴→阳反转后，押注反转方向在**下一根 5m K 线**上延续。

---

## 会话启停（压缩 ∧ 异动）

默认 **开启**（`SESSION_GATE_ENABLED=true`）。每 5m 收盘先做会话评估，**压缩与异动必须同时 pass** 才进入 ACTIVE 并执行 S1/S2。

**风险偏好：** `miss_big_move > small_loss` — 阈值初值偏松，放松体现在 `.env` 阈值上，**不是** OR 逻辑或单因子启停。

### 三要素

| 要素 | pass 条件 | 说明 |
|------|-----------|------|
| **volCompression** | 5m **ATR%** 在近 96 根分位 < 40%，**且** 连续 ≥12 根偏低 | 市场是否憋了一段时间 |
| **volumeAnomaly** | 以下**任一**：`periodVolRatio > 1.1` / 近 2 根量 > 12 均量 ×1.3 / 近 2 根均量 > 前 6 根 ×1.1 | 资金是否突然进场 |
| **eventWindow** | 可选 | `EVENT_WINDOW_ENABLED=true` 时读 `config/event-calendar.json`，**仅日志，不否决** |

```
evaluationPassed = volCompression.pass ∧ volumeAnomaly.pass
```

### 状态机

```
IDLE ──评估通过──▶ ACTIVE ──释放+量能确认──▶ RUNNING_BIG_MOVE
  ▲                    │                              │
  └──── 长期 fail 或无释放 ─┘         多项同步走弱 ────┘
```

| 状态 | 行为 |
|------|------|
| **IDLE** | 休眠：每 5m 评估，**不新开单**；仍结算 pending 注单 |
| **ACTIVE** | 运行：S1/S2 全执行；默认 continue |
| **RUNNING_BIG_MOVE** | 大行情段：续跑至波动+量能同步走弱 |

- **启动：** `evaluationPassed = true` → ACTIVE，Telegram 推送「会话启动」
- **停止：** ACTIVE 内连续 24 根评估 fail **且** 无波动释放 → IDLE
- **大行情：** 压缩释放 + 量能维持 → RUNNING_BIG_MOVE，Telegram 推送「大行情段」

日志：`logs/session.jsonl`（每周期评估）、`logs/session-state.json`（持久化状态）。

关闭门控：`SESSION_GATE_ENABLED=false`（等同常开，与旧行为一致）。

### 当前不做的事

- ~~低波动反转~~（不再根据 rv 切换方向）
- ~~rv_ratio / 成交量 per-trade 过滤~~（已移除单笔 skip）
- ~~runScore / 单因子启停~~
- 不使用 AI / 置信度打分
- 不对同向组合（阳阳/阴阴）下单

### 波动率字段

仍会拉取 **1m K 线**计算 `rv_5m` / `rv_15m`，**仅写入日志与 Telegram**，不参与信号方向或 per-trade 过滤。

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
│   ├── binance.js                   # CCXT OHLCV（信号 + 会话评估 + 1m rv 日志）
│   └── chainlink.js                 # RTDS Chainlink（结算）
├── strategy/reversalContinuation.js # S1/S2 高波延续
├── session/sessionGate.js           # 压缩∧异动 会话启停
├── market/polymarket.js             # Gamma 盘口（slug 随 TRADING_SYMBOL）
├── stats/manager.js                 # 盈亏 / 胜率 / 止损统计
├── trader/
│   ├── executor.js                  # CLOB 下单 GTC/FOK
│   ├── fillSync.js                  # 成交解析 + 短时轮询
│   ├── restingFillWatcher.js        # GTC 周期内补偿轮询
│   └── chainlinkSettle.js           # Chainlink 结算调度
├── martingale/manager.js
└── utils/                           # logger, retry, telegram, volatility, volumeFilter…
scripts/
├── backtest-daily-vol-pnl.js        # 日成交量 vs 盈亏回测
├── backtest-volume-filter-realtime.js
└── test-cycle.js                    # 单次周期空跑测试
docs/
└── ARCHITECTURE.md
config/
└── event-calendar.json              # 可选宏观催化（仅日志）
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

### 信号 / 结算

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADING_SYMBOL` | BTC/USDT | 信号 K 线 + Chainlink + Polymarket slug |
| `OHLCV_EXCHANGE` | okx | K 线主交易所（国内建议 okx） |
| `SIGNAL_DELAY_MS` | 10000 | 5m 边界后延迟再拉 K 线 |
| `CHAINLINK_SETTLE_BUFFER_MS` | 3000 | 周期结束后取 Chainlink 收盘价前的等待 |
| `CHAINLINK_SAFETY_INTERVAL_MS` | 60000 | 补结算安全网间隔 |

### 会话启停

| 变量 | 默认 | 说明 |
|------|------|------|
| `SESSION_GATE_ENABLED` | true | false = 常开，跳过会话评估 |
| `SESSION_CANDLE_LIMIT` | 100 | 评估时拉取 5m K 线根数 |
| `VOL_COMPRESS_LOOKBACK` | 96 | 压缩评估回看根数 |
| `VOL_COMPRESS_PERCENTILE` | 0.40 | ATR% 低位分位（偏松，可长期微调） |
| `VOL_COMPRESS_MIN_BARS` | 12 | 连续压缩根数 |
| `VOL_PERIOD_RATIO_MIN` | 1.1 | 1h/8h 量比下限 |
| `VOL_SPIKE_MULT` | 1.3 | 近 2 根量 / 近 12 根均量倍数 |
| `VOL_SPIKE_LOOKBACK` | 12 | spike 均量回看根数 |
| `VOL_MOMENTUM_MULT` | 1.1 | 近 2 根 / 前 6 根均量倍数 |
| `SESSION_OBSERVATION_BARS` | 24 | ACTIVE 内连续 fail 才停止 |
| `EVENT_WINDOW_ENABLED` | false | 催化窗口，仅日志 |
| `EVENT_WINDOW_HOURS` | 4 | 催化 ±小时 |
| `BIG_MOVE_CONFIRM_BARS` | 2 | 进入大行情段所需连续释放根数 |
| `BIG_MOVE_END_BARS` | 3 | 退出大行情段所需连续走弱根数 |

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
| `TRADE_BUDGET_USD` | 3 | 马丁基础注 |
| `MARTINGALE_MULTIPLIER` | 2 | 连亏翻倍 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏 4 次触发停机并重置 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限 |
| `MAX_BET_USD` | 10000 | 单笔下注上限 |
| `ORDER_PRICE_CAP` | 0.95 | YES/NO 对称封顶；`0`=不限制 |
| `VOLATILITY_BAR_TIMEFRAME` | 1m | rv 日志用 K 线周期（不改变信号） |
| `DRY_RUN` | false | true = 模拟下单 |

Polymarket / 钱包 / Telegram 变量见 `.env.example`。

---

## 运行逻辑

```
每 5m 周期
  │
  ├─ CCXT 拉 5m K 线（门控开启时扩展至 100 根）
  ├─ Chainlink 结算上一笔 pending-bet
  ├─ 会话评估：压缩 ∧ 异动 → IDLE / ACTIVE / RUNNING_BIG_MOVE
  │     └─ IDLE → 本周期结束（不新开单）
  ├─ 5m 形态 → S1/S2/NONE（固定高波延续）
  ├─ 风控：日亏损上限 / 马丁停机 / 余额
  ├─ Gamma 发现 Polymarket 5m 盘口 → CLOB 下单
  └─ 下一周期 Chainlink 结算 → 马丁 + 统计更新
```

- **会话 IDLE**：本周期不新开单，仍结算 pending。
- **无信号**或**风控拦截**：本周期不下单，马丁不变。
- **连亏 4 次**：下一周期跳过并重置为基础注。
- **赢一局**：马丁重置为 `TRADE_BUDGET_USD`。
- GTC 未成交不计入马丁；FOK 流动性不足会重试后跳过。

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
| `node scripts/backtest-daily-vol-pnl.js --days=365` | 日成交量 vs 盈亏回测 |
| `node scripts/backtest-volume-filter-realtime.js` | 成交量过滤器回测（离线） |

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
- 会话门控默认开启；若需与旧版「常开」一致，设 `SESSION_GATE_ENABLED=false`
- 阈值初值偏松，可在 `.env` 长期观察后微调（逻辑固定为压缩∧异动，只调数值）
- 服务器 `.env` 若仍保留 `RV_RATIO_MAX=1.05` 或 `VOLUME_FILTER_MODE=…`，请删除或置空；当前代码已不再使用
