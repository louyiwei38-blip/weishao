# Polymarket Reversal Continuation Bot

**PRD v2.4+** · BTC/USDT 5m · 高波动延续 · 放量窗会话门控 · 12 档动态首注 · Martingale 4-loss stop · CLOB V2 · OKX/Chainlink 结算 · GTC 限价

Polymarket 5 分钟涨跌盘口自动交易机器人：OKX 永续 5m K 线形态产生 S1/S2 信号，**放量窗**（可选定时常开）控制是否下单，CLOB 限价/市价下单，OKX K 线或 Chainlink oracle 结算，马丁格尔 + **活跃度 12 档动态首注**管理仓位。

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

## 会话启停（放量窗）

默认 **开启**（`SESSION_GATE_ENABLED=true`）。生产门控为 **放量窗**：单根 5m K 线 USDT 成交额 ≥ 触发线时开门，持续 `VOLUME_BURST_MINUTES`（默认 21 分钟）；窗口内再次触发只**刷新**截止时间，不叠加。

### 触发线（动态 / 固定）

| 模式 | 条件 | 说明 |
|------|------|------|
| **动态**（默认） | `DYNAMIC_THRESHOLD_ENABLED=true` | 近 `ACTIVITY_WINDOW_BARS`（12 根 = 1h）内，统计成交额 ≥ `ACTIVITY_PROBE_USDT_MIN` 的根数 → 活跃度越高，触发线越低（`BAR_VOLUME_USDT_MIN_DYNAMIC` … `BAR_VOLUME_USDT_MAX_DYNAMIC`） |
| **固定** | `DYNAMIC_THRESHOLD_ENABLED=false` | 本根成交额 ≥ `BAR_VOLUME_USDT_MIN`（默认 2500 万 USDT）即触发 |

### 可选定时常开（与放量窗 OR）

| 开关 | 说明 |
|------|------|
| `EVENT_WINDOW_ENABLED=true` | 读 `config/event-calendar.json`，宏观事件 ± `EVENT_WINDOW_HOURS` 内常开 |
| `US_MARKET_OPEN_ENABLED=true` | 美股北京时段（`US_MARKET_WINDOW_START_BJ`–`US_MARKET_WINDOW_END_BJ`，仅 NY 交易日）常开 |

默认两者均为 **false** → **仅放量窗**决定是否交易。

### 状态

| 状态 | 行为 |
|------|------|
| **IDLE** | 休眠：门控未通过，**不新开单**；仍结算 pending 注单 |
| **ACTIVE** | 运行：放量窗或定时常开有效，执行 S1/S2 |

- **启动：** 放量触发或定时常开 → ACTIVE，Telegram 推送「会话启动」
- **停止：** 放量窗到期且无定时常开 → IDLE

日志：`logs/session.jsonl`（每周期评估）、`logs/session-state.json`（持久化状态）。

关闭门控：`SESSION_GATE_ENABLED=false`（等同常开，与旧行为一致）。

### 当前不做的事

- ~~低波动反转~~（不再根据 rv 切换方向）
- ~~rv_ratio / 成交量 per-trade 过滤~~（已移除单笔 skip）
- ~~压缩 ∧ 异动 生产门控~~（`evaluateVolCompression` / `evaluateVolumeAnomaly` 仅旧回测脚本使用）
- ~~RUNNING_BIG_MOVE 状态机~~（已简化为 IDLE / ACTIVE）
- 不使用 AI / 置信度打分
- 不对同向组合（阳阳/阴阴）下单

### 波动率字段

仍会拉取 **1m K 线**计算 `rv_5m` / `rv_15m`，**仅写入日志与 Telegram**，不参与信号方向或 per-trade 过滤。

---

## 动态首注（活跃度 12 档 → 首注 4 桶）

默认 **开启**（`DYNAMIC_BASE_BET_ENABLED=true`）。近窗活跃度仍映射 **12 档**（0–12 根命中），但首注金额合并为 **4 桶**：**1–9 档同注**、**10 / 11 / 12 档各一注**。在新马丁序列开始时（`consecutiveLosses === 0`）按当前活跃度刷新首注；连亏中仍按 `MARTINGALE_MULTIPLIER` 加倍，**不在连亏中途改档**。

| 活跃度档位 | 首注（默认） |
|-----------|-------------|
| 1–9 档 | $1 |
| 10 档 | $6 |
| 11 档 | $8 |
| 12 档 | $24 |

- **赢一局**或**连亏 4 次停机**：下一序列重新按活跃度刷新首注
- 关闭：`DYNAMIC_BASE_BET_ENABLED=false` → 始终使用 `TRADE_BUDGET_USD`

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
│   ├── binance.js                   # CCXT OHLCV（OKX 永续 5m + 1m rv 日志）
│   └── chainlink.js                 # RTDS Chainlink（可选结算 / 交叉校验）
├── strategy/reversalContinuation.js # S1/S2 高波延续
├── session/sessionGate.js           # 放量窗 + 可选定时常开
├── market/polymarket.js             # Gamma 盘口（slug 随 TRADING_SYMBOL）
├── stats/manager.js                 # 盈亏 / 胜率 / 止损统计
├── martingale/
│   ├── manager.js                   # 马丁格尔序列
│   └── dynamicBaseBet.js            # 4 桶动态首注（1-9/10/11/12）
├── trader/
│   ├── executor.js                  # CLOB 下单 GTC/FOK
│   ├── fillSync.js                  # 成交解析 + 短时轮询
│   ├── restingFillWatcher.js        # GTC 周期内补偿轮询
│   └── chainlinkSettle.js           # OKX / Chainlink 结算调度
└── utils/                           # logger, retry, telegram, volatility, usMarketOpen…
scripts/
├── backtest-session-gate-v2.js      # 放量窗门控回测
├── backtest-dynamic-base-bet.js     # 动态首注回测（--recommended / --tier12-hybrid）
├── analyze-tier-only-roi.js         # 单档 vs 全档混合 ROI 对比
├── backtest-tier9-12-by-regime.js   # 9-12 档按行情段（月/季/波动）拆解
├── backtest-daily-vol-pnl.js        # 日成交量 vs 盈亏回测
├── backtest-volume-filter-realtime.js
└── test-cycle.js                    # 单次周期空跑测试
docs/
└── ARCHITECTURE.md
config/
└── event-calendar.json              # 可选宏观催化（定时常开）
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
| `TRADING_SYMBOL` | BTC/USDT | Polymarket slug + Chainlink 标的 |
| `OHLCV_EXCHANGE` | okx | K 线主交易所（国内建议 okx） |
| `OHLCV_MARKET_TYPE` | swap | `swap` = OKX USDT 永续 5m |
| `SIGNAL_DELAY_MS` | 10000 | 5m 边界后延迟再拉 K 线 |
| `SETTLE_SOURCE` | okx | `okx` = 永续 5m K 线结算；`chainlink` = RTDS oracle |
| `CHAINLINK_SETTLE_BUFFER_MS` | 3000 | Chainlink 模式下周期结束后等待 |
| `CHAINLINK_SAFETY_INTERVAL_MS` | 60000 | 补结算安全网间隔 |

### 会话门控（放量窗）

| 变量 | 默认 | 说明 |
|------|------|------|
| `SESSION_GATE_ENABLED` | true | false = 常开 |
| `SESSION_CANDLE_LIMIT` | 12 | 评估拉取 5m K 线根数 |
| `DYNAMIC_THRESHOLD_ENABLED` | true | false = 固定 `BAR_VOLUME_USDT_MIN` |
| `ACTIVITY_WINDOW_BARS` | 12 | 活跃度统计窗口（12×5m = 1h） |
| `ACTIVITY_PROBE_USDT_MIN` | 25000000 | 探测线：统计近窗内 ≥ 此值的根数 |
| `BAR_VOLUME_USDT_MIN_DYNAMIC` | 20000000 | 市场热时最低触发线 |
| `BAR_VOLUME_USDT_MAX_DYNAMIC` | 37000000 | 市场冷时最高触发线 |
| `BAR_VOLUME_USDT_MIN` | 25000000 | 固定模式触发线 |
| `VOLUME_BURST_MINUTES` | 21 | 触发后开门时长；再次触发只刷新 |
| `EVENT_WINDOW_ENABLED` | false | 宏观日历定时常开 |
| `EVENT_WINDOW_HOURS` | 1 | 宏观催化 ±小时 |
| `US_MARKET_OPEN_ENABLED` | false | 美股北京时段常开 |

### 动态首注

| 变量 | 默认 | 说明 |
|------|------|------|
| `DYNAMIC_BASE_BET_ENABLED` | true | false = 始终 `TRADE_BUDGET_USD` |
| `BASE_BET_TIER1_9_USD` | 1 | 活跃度 1–9 档首注 |
| `BASE_BET_TIER10_USD` | 6 | 活跃度 10 档首注 |
| `BASE_BET_TIER11_USD` | 8 | 活跃度 11 档首注 |
| `BASE_BET_TIER12_USD` | 24 | 活跃度 12 档首注 |

### 下单 / 成交

| 变量 | 默认 | 说明 |
|------|------|------|
| `ORDER_TYPE` | GTC* | `GTC` 限价 / `FOK` 市价（`.env.example` 推荐 GTC；未配置时代码默认 FOK） |
| `LIMIT_PRICE_OFFSET_TICKS` | 0 | 限价相对 best ask 的 tick 偏移 |
| `FILL_SYNC_POLL_MS` | 500 | 提交后 getOrder 轮询间隔 |
| `FILL_SYNC_MAX_WAIT_MS` | 8000 | 短时轮询最长等待 |
| `ORDER_FILL_ATTEMPTS` | 8 | FOK 未成交重试次数 |

### 马丁 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 3 | 动态首注关闭时的固定基础注 |
| `MARTINGALE_MULTIPLIER` | 2 | 连亏翻倍 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏 4 次触发停机并重置 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限 |
| `MAX_BET_USD` | 10000 | 单笔下注上限 |
| `ORDER_PRICE_CAP` | 0.95 | YES/NO 对称封顶；`0`=不限制 |
| `VOLATILITY_BAR_TIMEFRAME` | 1m | rv 日志用 K 线周期 |
| `DRY_RUN` | false | true = 模拟下单 |

Polymarket / 钱包 / Telegram 变量见 `.env.example`。

---

## 运行逻辑

```
每 5m 周期
  │
  ├─ CCXT 拉 OKX 永续 5m K 线（门控开启时扩展至 SESSION_CANDLE_LIMIT 根）
  ├─ 结算上一笔 pending-bet（SETTLE_SOURCE=okx | chainlink）
  ├─ 会话评估：放量窗 / 定时常开 → IDLE / ACTIVE
  │     └─ IDLE → 本周期结束（不新开单）
  ├─ 动态首注：新马丁序列时按活跃度刷新 base bet
  ├─ 5m 形态 → S1/S2/NONE（固定高波延续）
  ├─ 风控：日亏损上限 / 马丁停机 / 余额
  ├─ Gamma 发现 Polymarket 5m 盘口 → CLOB 下单
  └─ 下一周期结算 → 马丁 + 统计更新
```

- **会话 IDLE**：本周期不新开单，仍结算 pending。
- **无信号**或**风控拦截**：本周期不下单，马丁不变。
- **连亏 4 次**：下一周期跳过并重置序列（动态首注下次按活跃度刷新）。
- **赢一局**：马丁重置；动态首注下次按活跃度刷新。
- GTC 未成交不计入马丁；FOK 流动性不足会重试后跳过。

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 正式运行 |
| `npm run dry` | 空跑 |
| `npm run pm2:start` | PM2 启动（见 `ecosystem.config.cjs`） |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 API 凭证 |
| `node scripts/check-env.js` | 检查配置 |
| `DRY_RUN=true node scripts/test-cycle.js` | 单次周期测试 |
| `node scripts/backtest-session-gate-v2.js` | 放量窗门控回测 |
| `node scripts/backtest-dynamic-base-bet.js --days=365 --recommended` | 四档首注回测（默认 1-9:$1 · 10:$6 · 11:$8 · 12:$24） |
| `node scripts/backtest-dynamic-base-bet.js --days=365 --recommended --tier1-9=1 --tier10=6 --tier11=8 --tier12=24` | 自定义四档金额回测 |
| `node scripts/backtest-dynamic-base-bet.js --days=365 --tier12-hybrid` | 10/11/12 档金额网格搜索 |
| `node scripts/analyze-tier-only-roi.js --days=365` | 单档 vs 全档 ROI 对比（输出 `logs/analyze-tier-only-roi.json`） |
| `node scripts/backtest-tier9-12-by-regime.js --days=365` | 9-12 档按行情段拆解（月/季/波动/自定义窗口） |
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
- 国内服务器：`OHLCV_EXCHANGE=okx`、`OHLCV_MARKET_TYPE=swap`；Chainlink 模式需能访问 `wss://ws-live-data.polymarket.com`
- 默认 `SETTLE_SOURCE=okx`，不依赖 RTDS；若改 `chainlink`，首次部署建议 `DRY_RUN=true` 空跑，日志应出现 `[chainlink] RTDS buffer ready`
- 会话门控默认开启；若需与旧版「常开」一致，设 `SESSION_GATE_ENABLED=false`
- 放量触发线与活跃度档位可在 `.env` 长期观察后微调
- 服务器 `.env` 若仍保留 `VOL_COMPRESS_*`、`VOL_SPIKE_*`、`SESSION_OBSERVATION_BARS` 等旧压缩门控变量，可删除；生产门控不再读取
- 若仍保留 `RV_RATIO_MAX=1.05` 或 `VOLUME_FILTER_MODE=…`，请删除或置空；当前代码已不再使用
