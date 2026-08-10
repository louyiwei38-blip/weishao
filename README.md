# Polymarket 神奇九转 Bot

OKX USDT 永续 K 线 · **神奇九转** · **多流**（`.env`：`TRADING_STREAMS`，默认 12 流）· **共用本金 P / 净胜负 N + 补队列**（全实例同一 `BANKROLL_SCOPE=jz`）· 动态首注 · CLOB V2 · Chainlink/OKX 结算 · GTC 限价

默认 12 流：`btc/eth` 的 5m+15m+1h，`bnb/xrp/sol` 的 15m+1h（**无 bnb-5m**）。CLOB 限价/市价下单；默认 **Chainlink** 结算。策略相位 / pending / stats 按实例隔离；**账本全市场共用**一份 `logs/bankroll-state-jz.json`。

> 架构细节见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** · 部署见 **[DEPLOY.md](./DEPLOY.md)**

---

## 策略：神奇九转

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

TG 前缀例：`[BTC·5m·九转]`。

**安全闸门（下单前）：**

- 上笔 `pending-bet` 未结算 → 本周期不下单
- 仍有 GTC 挂单在监视中 → 本周期不下单（避免叠单）

> K 线默认 **OKX 永续**（`OHLCV_MARKET_TYPE=swap`），可与 `TRADING_SYMBOL`（Polymarket slug）分离配置。

不使用 AI。旧版 5m 反转仅保留在 `src/strategy/reversalContinuation.js`（若存在）供参考。

---

## 共用本金与动态首注（补队列）

**所有标的 × 所有周期** 共用同一账本文件：

| 作用域 | 文件 |
|--------|------|
| 九转（默认 `BANKROLL_SCOPE=jz`） | `logs/bankroll-state-jz.json` |

例：默认 12 个进程写入同一 P / N / 补队列（文件锁串行化）。

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
| 队列非空（或刚出现 gap） | 打最前未清除层 **L**；胜后目标利润 `T = L + step`；`stake = T × p/(1−p)`（`CATCHUP_T_CAP=0` 不封顶） |
| 硬上限 | `min(BANKROLL_STAKE_MAX_USD, MAX_BET_USD, Cash)`；**默认均为 0=无上限**（仍受 Cash 约束） |

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

# 推荐：.env 配置后 PM2 一键开齐（默认 12 流）
# TRADING_STREAMS=btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h
npm run pm2:dry               # 模拟盘
npm run pm2:start             # 实盘
pm2 logs

# 只开某一标的（5m+15m+1h）
npm run pm2:btc:start         # V3-btc-5m,15m,1h
npm run pm2:eth:start         # V3-eth-5m,15m,1h

# 单实例
npm run dry:5m
npm run start:btc:5m
npm run start:eth:5m
```

---

## 标的 / 周期：只改 `.env`

```env
TRADING_STREAMS=btc-5m,btc-15m,btc-1h,eth-5m,eth-15m,eth-1h,bnb-15m,bnb-1h,xrp-15m,xrp-1h,sol-15m,sol-1h
```

（旧写法仍可用：`TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` 全笛卡尔积；与 `TRADING_STREAMS` 同时存在时以 streams 为准。）

然后：

```bash
pm2 delete all
npm run pm2:start                # 或 pm2:dry
# Telegram 话题（若用论坛群；按实例自动扩展）：
npm run setup:tg-topics -- --write-env
```

示例进程：`V3-btc-5m`、`V3-bnb-15m`、`V3-sol-1h`、…（全部九转，共用 `bankroll-state-jz.json`）。

可选话题：`TELEGRAM_THREAD_BTC_5M`、`TELEGRAM_THREAD_XRP_15M` 等。

Chainlink 已支持：`BTC / ETH / SOL / BNB / XRP / DOGE`（需 Polymarket 有对应 Up/Down 盘口）。

---

## PM2（`TRADING_STREAMS`）

- 共用同一 `.env` 钱包 / CLOB 凭证
- **账本全实例共用**（`STRATEGY=jz`、`BANKROLL_SCOPE=jz` → `bankroll-state-jz.json`）
- `BOT_INSTANCE`（如 `btc-5m` / `sol-1h`）隔离 pending / 统计 / 马丁 / 九转相位 / 日志
- Telegram 可用**一个论坛群 + Topics**（见 [DEPLOY.md](./DEPLOY.md)）
- `MARKET_CYCLE_MINUTES` 可省略：由 `CANDLE_TIMEFRAME` 自动推导（`5m→5`，`15m→15`，`1h→60`）
- ecosystem 注入 `MARTINGALE_MAX_LOSSES=2`（胜结束 · 输锁 1 次）

---

## 项目结构

```
src/
├── index.js                         # 调度入口（结算 + 信号 + 下单 + TG）
├── config.js                        # 环境变量；strategy=jz / bankrollScope
├── collector/
│   ├── binance.js                   # CCXT OHLCV（OKX 永续）
│   └── chainlink.js                 # RTDS（SETTLE_SOURCE=chainlink）
├── strategy/
│   ├── activeStrategy.js            # 九转门面
│   ├── magicNineTurns.js            # 神奇九转 Setup 检测
│   └── jzState.js                   # idle / in_chain（胜结束 · 输锁1次）
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
│   └── bankroll.js                  # 共用 P/N + 补队列动态首注
└── utils/
    ├── instancePaths.js             # pending-bet-{id}.json 等
    ├── logger.js / telegram.js …
scripts/
├── run-instance.js                  # 单实例：--symbol
├── backtest-jz-global-shared.js     # 多标的多周期共用账本回测
├── lib/tradingUniverse.cjs          # 标的×周期解析
└── setup-telegram-topics.js         # 论坛话题写入 .env
ecosystem.config.cjs                 # PM2：V3-{base}-{tf}
```

### 日志 / 状态

**共用账本：**

| 文件 | 说明 |
|------|------|
| `logs/bankroll-state-jz.json` | 全市场：P、N、补队列、realizedPnl |

**按实例后缀**（`BOT_INSTANCE`，如 `btc-5m` / `eth-1h`）：

| 文件 | 说明 |
|------|------|
| `logs/pending-bet-*.json` | 待结算注单 |
| `logs/jz-state-*.json` | 九转相位 |
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
| `TRADING_STREAMS` | 见右 | **PM2 流列表**（默认 12 流，可非全矩阵） |
| `TRADING_SYMBOLS` | — | 旧：标的列表（无 STREAMS 时与 TFs 笛卡尔积） |
| `CANDLE_TIMEFRAMES` | — | 旧：周期列表 |
| `STRATEGY` | jz | 固定神奇九转（写其它值会被忽略） |
| `BANKROLL_SCOPE` | jz | → `bankroll-state-jz.json`（全实例共用） |
| `TRADING_SYMBOL` | BTC/USDT | 单进程 slug；PM2 时注入 |
| `CANDLE_TIMEFRAME` | 5m | 单进程默认；PM2 覆盖 |
| `MARKET_CYCLE_MINUTES` | 随 timeframe | 可省略 |
| `BOT_INSTANCE` | `{base}-{tf}` | 状态文件后缀 |
| `SIGNAL_DELAY_MS` | 按周期 | 新信号延迟（5m→3s / 15m→4s / 1h→5s） |
| `IN_CHAIN_SIGNAL_DELAY_MS` | 100 | 续单 / 锁单短延迟 |
| `MG_CONT_FAST_PATH` | true | 结算输且未满连亏上限时，立即对下一窗口同向下单 |
| `PREWARM_MS` | 5000 | 周期边界前提前预热 |

### 马丁 / 动态首注 / 风控 / 结算

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | **5** | 跟上目标线时的默认投入 |
| `MAX_BET_USD` | **0** | 单笔硬上限；`0`=不限制（仍受 Cash） |
| `BANKROLL_STEP_USD` | 10 | 目标线步进；补层 T=L+step |
| `BANKROLL_CATCHUP_T_CAP` | **0** | 补层目标净利 T 上限；`0`=不限制 |
| `BANKROLL_STAKE_MAX_USD` | **0** | 动态仓位单笔上限；`0`=不限制 |
| `BANKROLL_USE_STATS_EQUITY` | true | gap 用 P+账本盈亏（非延迟 Portfolio） |
| `MARTINGALE_MULTIPLIER` | 1 | 连亏倍数（仓位由动态首注重算） |
| `MARTINGALE_MAX_LOSSES` | **2** | 入场 + 同向锁单 1 次后 halt（PM2 亦注入） |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限（**每实例**） |
| `ORDER_PRICE_CAP` | 0.55 | ask≤cap 市价；ask>cap 限价@cap；`0`=不限制 |
| `ORDER_TYPE` | FOK | 与 cap 配合：`FOK`=阈值模式；`GTC`=始终挂 best ask |
| `UNFILLED_LIMIT_FORCE_WIN` | true | 限价未成交 → 强制算赢（N+1；账本只加 `BANKROLL_STEP_USD`，不算开单盈亏） |
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
  │                 输且未 halt → 九转锁单快路径
  ├─ in_chain：跳过新信号检测，同向锁单
  ├─ idle：检测九转 Setup 完成 → 下单
  ├─ 风控：日亏损 / Portfolio·Cash
  └─ 成交后登记 pending → 结算 → 更新马丁 + 九转态 + 共用账本
```

- **无信号 / 风控拦截**：不下单  
- **九转赢 / 锁单完成（halt）**：回 `idle`；P/N 不重置  
- **结算输且未 halt**：快路径同向下一窗；N −1；补队列均分更新  
- GTC 未成交不计入马丁 / 不改 N  

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run pm2:start` | 实盘：标的 × 周期 开齐（共用账本） |
| `npm run pm2:dry` | 模拟盘同上 |
| `npm run pm2:restart` / `pm2:stop` / `pm2:logs` | 重启 / 停止 / 日志 |
| `npm run pm2:btc:start` | `V3-btc-5m/15m/1h` |
| `npm run pm2:eth:start` | `V3-eth-5m/15m/1h`（需 SYMBOLS 含 ETH） |
| `npm run start:btc:5m` / `start:eth:5m` | 单进程九转 |
| `npm run dry:5m` / `dry:15m` / `dry:1h` | 单进程空跑 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 CLOB API 凭证 |
| `npm run setup:tg-topics` | 按实例创建/写入 Telegram 话题 |
| `node scripts/check-env.js` | 检查配置 |
| `node scripts/backtest-jz-global-shared.js` | 多标的多周期共用账本回测 |
| `node scripts/backtest-jz-multitf-shared.js --all` | 同标的多周期共用账本回测 |

---

## 回测

```bash
# 全局共用账本：BTC+ETH × 5m/15m/1h
node scripts/backtest-jz-global-shared.js --from=2020-01-01

# 按标的：各标的内部 5m+15m+1h 共用一本
node scripts/backtest-jz-multitf-shared.js --all --from=2020-01-01
```

结果写入 `logs/backtest-jz-*.json`。

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。

```bash
cp .env.example .env    # 私钥 / Telegram / TRADING_STREAMS
npm install
npm run pm2:dry         # 先空跑
npm run pm2:start
pm2 save && pm2 startup
```

---

## 注意事项

- 钱包需有足够 **pUSD Cash**；多开（多流）时注意同时加仓的余额与敞口（共用一本账本）
- 账本文件：`logs/bankroll-state-jz.json`
- 国内：`OHLCV_EXCHANGE=okx`；需访问 Gamma / CLOB / OKX，以及 Chainlink RTDS（默认结算）
- 首次务必 `DRY_RUN` / `pm2:dry` 确认信号与 slug 正常后再实盘
- 改过 `TRADING_STREAMS`（或旧 `TRADING_SYMBOLS` / `CANDLE_TIMEFRAMES`）后必须 `pm2 delete all` 再 `pm2:start`（进程列表会变）
- `.env` 中旧版 `SESSION_GATE_*`、`ACTIVITY_*`、`VOLATILITY_*` 等实盘不再读取，可删除
