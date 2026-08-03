# Polymarket Vegas Channel Bot

OKX USDT 永续 K 线 · **双策略并行**：维加斯通道（EMA144/169）+ **神奇九转** · **默认单标的 × 单周期**（`.env`：`TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` × `STRATEGIES`）· **本金 P / 净胜负 N + 补队列**（按策略账本隔离）· 动态首注（默认 **$5** / 补层 T=L+step / 单笔≤$30）· CLOB V2 · Chainlink/OKX 结算 · GTC 限价

默认 `TRADING_SYMBOLS=BTC`、`CANDLE_TIMEFRAMES=5m`、`STRATEGIES=vegas,jz`；CLOB 限价/市价下单；默认 **Chainlink** 结算。状态文件按实例隔离；**维加斯 / 九转各用独立账本与补队列**，互不干扰。

> 架构细节见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** · 部署见 **[DEPLOY.md](./DEPLOY.md)**

---

## 策略

通过 `.env` 的 `STRATEGIES=vegas,jz` 同时跑两套（同标的、独立进程 / 账本 / TG）。也可只写 `vegas` 或只写 `jz`。

### 1) 维加斯通道（`STRATEGY=vegas`）

通道：`lower = min(EMA144, EMA169)`，`upper = max(EMA144, EMA169)`。  
EMA 由 **OKX Indicators API** 拉取（`src/collector/okxIndicators.js`），OHLCV 实体/影线仍来自 CCXT（默认 OKX 永续）。

| 条件 | 信号 | 操作 |
|------|------|------|
| 上一根实体完全在通道上方 + 本根影线入通道（`low ≤ upper`） | **VG_UP** | 下一周期买涨（YES） |
| 上一根实体完全在通道下方 + 本根影线入通道（`high ≥ lower`） | **VG_DOWN** | 下一周期买跌（NO） |
| 其它 | NONE | 跳过 |

**状态机：**

1. `need_outside` — 等待至少一根已收盘 K **实体完全在通道外**，才进入 `armed`
2. `armed` — 检测穿越入场；有信号则锁定方向进入 `in_chain` 并下首注
3. `in_chain` — **不做新信号检测**；每周期同向续下（马丁 ×1）
4. 赢 → 停止并回 `need_outside`；连亏 **5** 次 → 止损并回 `need_outside`（**不重置**本金 P / 净胜负 N）

### 2) 神奇九转（`STRATEGY=jz`）

TD Sequential 式 Setup（`src/strategy/magicNineTurns.js`）：

| Setup | 条件（连续计数） | 本周期操作 |
|-------|------------------|------------|
| **Buy Setup** | 收盘价 &lt; 4 根前收盘 → +1，否则清零；满 **9** 完成并清零 | **JZ_UP** 买涨（反转） |
| **Sell Setup** | 收盘价 &gt; 4 根前收盘 → +1，否则清零；满 **9** 完成并清零 | **JZ_DOWN** 买跌（反转） |

满 9 后计数清零，后续若条件仍成立则从 **1** 再起算（不做 Perfect / TD13）。Buy、Sell 同根同时完成 → 跳过。

**链路：**

1. 九转完成 → 入场并锁定方向（`in_chain`）
2. **赢 → 立刻结束链路**
3. **输 → 同向锁单 1 次**（仅一次；`MARTINGALE_MAX_LOSSES=2`）
4. 锁单后再结算（无论胜负）→ 结束链路，等待下一次九转

TG 前缀带 `·九转`（例：`[BTC·5m·九转]`），与维加斯消息分开。

**安全闸门（下单前，两策略共用逻辑）：**

- 上笔 `pending-bet` 未结算 → 本周期不下单
- 仍有 GTC 挂单在监视中 → 本周期不下单（避免叠单）

> K 线默认 **OKX 永续**（`OHLCV_MARKET_TYPE=swap`），可与 `TRADING_SYMBOL`（Polymarket slug）分离配置。

不使用 AI。旧版 5m 反转策略仅保留在 `src/strategy/reversalContinuation.js`（回测脚本用）。

---

## 共用本金与动态首注（补队列）

账本按 **策略作用域** 分文件（不是全钱包混成一份）：

| 作用域 | 文件 |
|--------|------|
| 维加斯（`BANKROLL_SCOPE=vegas`） | `logs/bankroll-state.json` |
| 神奇九转（`BANKROLL_SCOPE=jz`） | `logs/bankroll-state-jz.json` |

同一作用域内多标的（如 BTC+ETH 维加斯）仍共享该文件的 P / N / 补队列。

| 符号 | 含义 |
|------|------|
| **P** | 本金，首次从 Portfolio 锁定；**连亏止损不重置** |
| **N** | 净胜负次数（确认结算后 ±1）；**连亏止损不重置** |
| 目标线 | `P + N × BANKROLL_STEP_USD` |
| **gap** | `max(0, 目标 − equity)`；默认 `BANKROLL_USE_STATS_EQUITY=true` 时 equity = `P + 账本累计盈亏` |
| **补队列** | 未清除层 `[补1, 补2, …]` |

**仓位（每枪，含 MG_CONT / 九转锁单）：**

| 条件 | 注码 |
|------|------|
| gap≈0 且队列空 | `TRADE_BUDGET_USD`（默认 **$5**） |
| 队列非空（或刚出现 gap） | 打最前未清除层 **L**；胜后目标利润 `T = L + step`；`stake = T × p/(1−p)`（再 `T≤CATCHUP_T_CAP`） |
| 硬上限 | `min(BANKROLL_STAKE_MAX_USD, MAX_BET_USD, Cash)` |

**补队列纪律：**

- 输：出手层不变；若 gap 变大则追加新层，再把 **总 gap 均分到剩余各层**
- 赢：清除当前层；剩余多层同样 **按 gap 均分**；空且 gap≈0 → 回默认首注；空但仍有 gap → 新开补1
- **Cash** → 实际可花金额与补仓上限（避免用浮盈超花）

---

## 结算

| `SETTLE_SOURCE` | 数据源 | 规则 |
|-----------------|--------|------|
| `okx` | OKX 永续同周期 K 线 | `close >= open → UP`，否则 DOWN |
| `chainlink`（**默认**） | Polymarket RTDS | `close >= target → UP`（需 RTDS 连通） |

- 开单时尽量锁定 Chainlink 开盘价（`targetPrice`）写入 pending
- Chainlink 不可用时 **回退 OKX K 线结算**，保证账本能入账
- 默认不因 RTDS 短暂中断而拒单（`CHAINLINK_REQUIRE_FOR_OPEN=false`）；结算侧负责兜底

---

## 快速开始

```bash
npm install
cp .env.example .env          # 模拟盘可 DRY_RUN=true
node scripts/check-env.js

# 推荐：.env 配置后 PM2 一键开齐
# TRADING_SYMBOLS=BTC,ETH
# CANDLE_TIMEFRAMES=5m
# STRATEGIES=vegas,jz
npm run pm2:dry               # 模拟盘
npm run pm2:start             # 实盘
pm2 logs

# 只开某一标的（维加斯 + 九转）
npm run pm2:btc:start         # V3-btc-5m + V3-btc-5m-jz
npm run pm2:eth:start         # V3-eth-5m + V3-eth-5m-jz

# 单实例
npm run dry:5m
npm run start:btc:5m
npm run start:eth:5m
npm run start:eth:5m:jz       # ETH 神奇九转
npm run start:btc:5m:jz       # BTC 神奇九转
```

---

## 标的 / 周期 / 策略：只改 `.env`

```env
TRADING_SYMBOLS=BTC,ETH
CANDLE_TIMEFRAMES=5m
STRATEGIES=vegas,jz
```

然后：

```bash
pm2 delete all
npm run pm2:start                # 或 pm2:dry
# Telegram 话题（若用论坛群；会按实例含 *-jz 自动扩展）：
npm run setup:tg-topics -- --write-env
```

示例进程：`V3-btc-5m`、`V3-btc-5m-jz`、`V3-eth-5m`、`V3-eth-5m-jz`。

可选话题：`TELEGRAM_THREAD_BTC_5M_JZ`、`TELEGRAM_THREAD_ETH_5M_JZ`。

Chainlink 已支持：`BTC / ETH / SOL / BNB / XRP / DOGE`（需 Polymarket 有对应 Up/Down 盘口）。

---

## PM2（`TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` × `STRATEGIES`）

- 共用同一 `.env` 钱包 / CLOB 凭证
- **账本按策略隔离**（vegas / jz）；同策略多标的共享该策略账本
- `BOT_INSTANCE`（如 `btc-5m` / `eth-5m-jz`）隔离 pending / 统计 / 马丁 / 日志
- Telegram 可用**一个论坛群 + Topics**（见 [DEPLOY.md](./DEPLOY.md)）
- `MARKET_CYCLE_MINUTES` 可省略：由 `CANDLE_TIMEFRAME` 自动推导（`5m→5`，`15m→15`，`1h→60`）
- 九转实例由 ecosystem 注入 `STRATEGY=jz`、`BANKROLL_SCOPE=jz`、`MARTINGALE_MAX_LOSSES=2`

---

## 项目结构

```
src/
├── index.js                         # 调度入口（结算 + 信号 + 下单 + TG）
├── config.js                        # 环境变量；strategy / bankrollScope
├── collector/
│   ├── binance.js                   # CCXT OHLCV（OKX 永续）
│   ├── okxIndicators.js             # OKX EMA144/169 通道带
│   └── chainlink.js                 # RTDS（SETTLE_SOURCE=chainlink）
├── strategy/
│   ├── activeStrategy.js            # vegas | jz 门面
│   ├── vegasChannel.js              # 穿越判定
│   ├── vegasState.js                # need_outside / armed / in_chain
│   ├── magicNineTurns.js            # 神奇九转 Setup 检测
│   ├── jzState.js                   # idle / in_chain（胜结束 · 输锁1次）
│   └── reversalContinuation.js      # 旧策略（回测用）
├── market/polymarket.js             # Gamma：{base}-updown-{tf}-{sec}
├── stats/manager.js                 # 盈亏统计（按实例隔离）
├── trader/
│   ├── executor.js                  # CLOB GTC/FOK；Portfolio / Cash
│   ├── fillSync.js                  # 成交解析（多笔合计）
│   ├── restingFillWatcher.js        # GTC 周期内监视
│   ├── polymarketFees.js            # Crypto 吃单费
│   └── chainlinkSettle.js           # OKX / Chainlink 结算（含 OKX 回退）
├── martingale/
│   ├── manager.js                   # 同向马丁（按实例隔离）
│   └── bankroll.js                  # 按 scope 的 P/N + 补队列动态首注
└── utils/
    ├── instancePaths.js             # pending-bet-{id}.json 等
    ├── logger.js / telegram.js …
scripts/
├── run-instance.js                  # 单实例：--symbol / --strategy=jz
├── backtest-vegas-1h.js             # 维加斯回测
├── lib/tradingUniverse.cjs          # 标的×周期×策略解析
└── setup-telegram-topics.js         # 论坛话题写入 .env
ecosystem.config.cjs                 # PM2：V3-{base}-{tf}[-jz]
```

### 日志 / 状态

**按策略账本：**

| 文件 | 说明 |
|------|------|
| `logs/bankroll-state.json` | 维加斯：P、N、补队列、realizedPnl |
| `logs/bankroll-state-jz.json` | 九转：同上（独立） |

**按实例后缀**（`BOT_INSTANCE`，如 `btc-5m` / `eth-5m-jz`）：

| 文件 | 说明 |
|------|------|
| `logs/pending-bet-*.json` | 待结算注单 |
| `logs/vegas-state-*.json` / `jz-state-*.json` | 策略相位 |
| `logs/martingale-state-*.json` | 马丁注码 / 连亏 |
| `logs/settlements-*.jsonl` | 结算流水 |
| `logs/trades-*.jsonl` | 下单流水 |
| `logs/signals-*.jsonl` | 信号流水 |
| `logs/stats-state-*.json` | 盈亏统计 |
| `logs/heartbeat-*.json` | 心跳 |
| `logs/bot-*.log` | Winston 日志 |

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### K 线 / 信号 / 策略

| 变量 | 默认 | 说明 |
|------|------|------|
| `OHLCV_EXCHANGE` | okx | K 线主交易所 |
| `OHLCV_MARKET_TYPE` | swap | `swap`=USDT 永续；`spot`=现货 |
| `TRADING_SYMBOLS` | BTC | **PM2 标的列表**（可 `BTC,ETH`） |
| `CANDLE_TIMEFRAMES` | 5m | **PM2 周期列表** |
| `STRATEGIES` | vegas | **PM2 策略列表**（`vegas` / `jz` / `vegas,jz`） |
| `STRATEGY` | vegas | 单进程策略；PM2 由 ecosystem 注入 |
| `BANKROLL_SCOPE` | 随 STRATEGY | `vegas`→`bankroll-state.json`；`jz`→`bankroll-state-jz.json` |
| `TRADING_SYMBOL` | BTC/USDT | 单进程 slug；PM2 时注入 |
| `CANDLE_TIMEFRAME` | 5m | 单进程默认；PM2 覆盖 |
| `MARKET_CYCLE_MINUTES` | 随 timeframe | 可省略 |
| `BOT_INSTANCE` | `{base}-{tf}[-jz]` | 状态文件后缀 |
| `SIGNAL_DELAY_MS` | 按周期 | 新信号延迟（5m→3s / 15m→4s / 1h→5s） |
| `IN_CHAIN_SIGNAL_DELAY_MS` | 100 | 续单 / 锁单短延迟 |
| `MG_CONT_FAST_PATH` | true | 结算输且未满连亏上限时，立即对下一窗口同向下单 |
| `PREWARM_MS` | 5000 | 周期边界前提前预热 |

### 马丁 / 动态首注 / 风控 / 结算

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | **5** | 跟上目标线时的默认投入 |
| `MAX_BET_USD` | 30 | 单笔硬上限 |
| `BANKROLL_STEP_USD` | 10 | 目标线步进；补层 T=L+step |
| `BANKROLL_CATCHUP_T_CAP` | 20 | 补层目标净利 T 硬上限 |
| `BANKROLL_STAKE_MAX_USD` | 30 | 动态仓位单笔上限 |
| `BANKROLL_USE_STATS_EQUITY` | true | gap 用 P+账本盈亏（非延迟 Portfolio） |
| `MARTINGALE_MULTIPLIER` | 1 | 连亏倍数（仓位由动态首注重算） |
| `MARTINGALE_MAX_LOSSES` | 5 / **jz→2** | 维加斯默认 5；九转由 PM2 注入 2（胜结束·输锁1次） |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限（**每实例**） |
| `ORDER_PRICE_CAP` | 0.95 | `.env.example` 推荐 `0.60`；`0`=不限制 |
| `ORDER_TYPE` | GTC | `GTC` 限价 / `FOK` 市价 |
| `DRY_RUN` | false | `true`=模拟下单 |
| `SETTLE_SOURCE` | chainlink | `okx` / `chainlink` |
| `INCLUDE_TRADING_FEES` | true | 盈亏统计是否扣 Crypto 吃单费 |
| `CHAINLINK_REQUIRE_FOR_OPEN` | false | `true` 时 RTDS 未就绪则跳过开单 |

钱包 / Telegram 见 `.env.example`。

---

## 运行逻辑（单实例）

```
周期边界前 PREWARM：预热 Gamma / CLOB / 余额
周期边界 + 延迟（新信号 SIGNAL_DELAY / in_chain 短延迟）
  │
  ├─ 若有 pending → 结算（Chainlink，失败则 OKX 回退）
  │                 输且未 halt → MG_CONT / 九转锁单快路径
  ├─ in_chain：跳过新信号检测，同向续单 / 锁单
  ├─ vegas armed：OKX EMA 穿越 → 下单
  ├─ jz idle：检测九转 Setup 完成 → 下单
  ├─ 风控：日亏损 / Portfolio·Cash
  └─ 成交后登记 pending（含 targetPrice）→ 结算 → 更新马丁 + 策略态 + 本策略账本
```

- **无信号 / 风控拦截**：不下单  
- **维加斯赢 / 连亏 5**：回 `need_outside`；P/N 不重置  
- **九转赢 / 锁单完成（halt）**：回 `idle`  
- **结算输且未 halt**：快路径同向下一窗；N −1；补队列均分更新  
- GTC 未成交不计入马丁 / 不改 N  

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run pm2:start` | 实盘：标的 × 周期 × 策略 开齐 |
| `npm run pm2:dry` | 模拟盘同上 |
| `npm run pm2:restart` / `pm2:stop` / `pm2:logs` | 重启 / 停止 / 日志 |
| `npm run pm2:btc:start` | `V3-btc-5m` + `V3-btc-5m-jz` |
| `npm run pm2:eth:start` | `V3-eth-5m` + `V3-eth-5m-jz`（需 SYMBOLS 含 ETH） |
| `npm run start:btc:5m` / `start:eth:5m` | 单进程维加斯 |
| `npm run start:btc:5m:jz` / `start:eth:5m:jz` | 单进程神奇九转 |
| `npm run dry:5m` / `dry:15m` / `dry:1h` | 单进程空跑 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 CLOB API 凭证 |
| `npm run setup:tg-topics` | 按实例（含 jz）创建/写入 Telegram 话题 |
| `node scripts/check-env.js` | 检查配置 |
| `node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01` | 维加斯离线回测 |

---

## 回测

```bash
# 维加斯：动态首注默认 $5、T≤$20、单笔≤$30、连亏 5、入场价 0.50、含手续费
node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01 --base=5
node scripts/backtest-vegas-1h.js --timeframe=5m --from=2020-01-01 --symbol=ETH/USDT
node scripts/backtest-vegas-1h.js --days=30 --symbol=BTC/USDT

# 可选：EMA 堆叠过滤
node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01 --emaStackFilter=true

# 其它：--base=5 --mult=1 --maxLosses=5 --entry=0.50 --fee=true --force
```

结果写入 `logs/backtest-vegas-{base}-{tf}.json` 与 `*-trades.csv`。

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。

```bash
cp .env.example .env    # 私钥 / Telegram / TRADING_SYMBOLS / STRATEGIES
npm install
npm run pm2:dry         # 先空跑
npm run pm2:start
pm2 save && pm2 startup
```

---

## 注意事项

- 钱包需有足够 **pUSD Cash**；多开（多标的 × 双策略）时注意同时加仓的余额与敞口
- 维加斯与九转 **账本分离**：重置时分别处理 `bankroll-state.json` / `bankroll-state-jz.json`
- 国内：`OHLCV_EXCHANGE=okx`；需访问 Gamma / CLOB / OKX，以及 Chainlink RTDS（默认结算）
- 首次务必 `DRY_RUN` / `pm2:dry` 确认信号与 slug 正常后再实盘
- 改过 `TRADING_SYMBOLS` / `STRATEGIES` 后必须 `pm2 delete all` 再 `pm2:start`（进程列表会变）
- `.env` 中旧版 `SESSION_GATE_*`、`ACTIVITY_*`、`VOLATILITY_*` 等实盘不再读取，可删除
