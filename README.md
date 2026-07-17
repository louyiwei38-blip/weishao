# Polymarket Vegas Channel Bot

OKX USDT 永续 K 线 · **OKX 指标 API** EMA144/EMA169 维加斯通道穿越入场 · **多标的（`.env` 的 `TRADING_SYMBOLS`）** × 5m/15m/1h · **全实例共用本金 P / 净胜负 N** · 动态首注（默认 $10 / 追赶 T≤$20 / 单笔≤$30）· 仓位按 **Polymarket Portfolio（Cash + 持仓市值）** 计算 · CLOB V2 · Chainlink/OKX 结算 · GTC 限价

Polymarket 涨跌盘口可按 `.env` 配置多标的并行：例如 `TRADING_SYMBOLS=BTC,ETH` → 各周期独立进程；CLOB 限价/市价下单；默认 **Chainlink** 结算；同向马丁管理链路。状态文件按实例隔离；本金状态全钱包共享。

> 架构细节见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** · 部署见 **[DEPLOY.md](./DEPLOY.md)**

---

## 策略

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
4. 赢 → 停止并回 `need_outside`；连亏 5 次 → 止损重置并回 `need_outside`（同时重置本金 P＝当时 Portfolio、净胜负 N＝0）

**安全闸门（下单前）：**

- 上笔 `pending-bet` 未结算 → 本周期不下单
- 仍有 GTC 挂单在监视中 → 本周期不下单（避免叠单）

> K 线默认 **OKX BTC/USDT:USDT 永续**（`OHLCV_MARKET_TYPE=swap`），可与 `TRADING_SYMBOL`（Polymarket slug）分离配置。

不使用 AI。旧版 5m 反转策略仅保留在 `src/strategy/reversalContinuation.js`（回测脚本用）。

---

## 共用本金与动态首注

所有 PM2 实例（标的 × 周期）共享同一钱包的本金状态：`logs/bankroll-state.json`。

| 符号 | 含义 |
|------|------|
| **P** | 本金，首次从 Portfolio 锁定；**连亏止损时按当时 Portfolio 重新锁定** |
| **N** | 净胜负次数（仅确认结算后 ±1）；**连亏止损时重置为 0** |
| 目标线 | `P + N × BANKROLL_STEP_USD` |

**仓位（每枪，含 MG_CONT）：**

| 条件 | 注码 |
|------|------|
| Portfolio ≥ 目标线 | `TRADE_BUDGET_USD`（默认 $10） |
| 落后目标线 | 按 `gap = 目标 − Portfolio` **分档多次回补**：`gap≤5` → T=gap；`gap≤15` → T=gap/2；否则 T=gap/3；再 `T≤CATCHUP_T_CAP`，`stake = T × p/(1−p)` |
| 硬上限 | `min(BANKROLL_STAKE_MAX_USD, MAX_BET_USD, Cash)` |

- **Portfolio**（Cash + 持仓市值）→ 判断是否跟上目标线、算追赶注码  
- **Cash** → 实际可花金额与补仓上限（避免用浮盈超花）

---

## 结算

| `SETTLE_SOURCE` | 数据源 | 规则 |
|-----------------|--------|------|
| `okx` | OKX 永续同周期 K 线 | `close >= open → UP`，否则 DOWN |
| `chainlink`（**默认**） | Polymarket RTDS | `close >= target → UP`（需 RTDS 连通） |

默认 Chainlink 模式会启 RTDS；`SETTLE_SOURCE=okx` 时不启 Chainlink RTDS。

---

## 快速开始

```bash
npm install
cp .env.example .env          # 模拟盘可 DRY_RUN=true
node scripts/check-env.js

# 推荐：改 .env 的 TRADING_SYMBOLS 后 PM2 一键开齐
# TRADING_SYMBOLS=BTC,ETH
npm run pm2:dry               # 模拟盘（标的×周期）
npm run pm2:start             # 实盘
pm2 logs

# 或单实例
npm run dry:5m
npm run start:btc:5m
npm run start:eth:1h
```

---

## 多标的：只改 `.env`

```env
TRADING_SYMBOLS=BTC,ETH          # 或 BTC/USDT,ETH/USDT,SOL
CANDLE_TIMEFRAMES=5m,15m,1h      # 可选；默认三周期
```

然后：

```bash
pm2 delete all
npm run pm2:start                # 或 pm2:dry
# Telegram 话题（若用论坛群）：
npm run setup:tg-topics -- --write-env
```

Chainlink 已支持：`BTC / ETH / SOL / BNB / XRP / DOGE`（需 Polymarket 有对应 Up/Down 盘口）。

---

## 多实例 → PM2（由 `TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` 生成）

| PM2 进程 | 周期 | 盘口 slug 示例 |
|----------|------|----------------|
| `V3-btc-5m` 等 | 5 分钟 | `btc-updown-5m-<unix>` |
| `V3-btc-15m` 等 | 15 分钟 | `btc-updown-15m-<unix>` |
| `V3-eth-1h` 等 | 1 小时 | `ethereum` / `btc` 等 1h ET slug |

- 共用同一 `.env` 钱包 / CLOB 凭证 / **本金 P·N**
- `BOT_INSTANCE`（如 `btc-15m`）+ `CANDLE_TIMEFRAME` 隔离状态与日志
- Telegram 消息带 `[BTC·15m]` / `[ETH·5m]` 前缀；可用**一个论坛群 + Topics**按实例分话题（见 [DEPLOY.md](./DEPLOY.md)）
- `MAX_DAILY_LOSS_USD` **按实例分别累计**（多路合计可能超过单路上限）
- `MARKET_CYCLE_MINUTES` 可省略：由 `CANDLE_TIMEFRAME` 自动推导（`5m→5`，`15m→15`，`1h→60`）

---

## 项目结构

```
src/
├── index.js                         # 调度入口（结算 + 信号 + 下单 + TG）
├── config.js                        # 环境变量；cycleMinutes 可由 timeframe 推导
├── collector/
│   ├── binance.js                   # CCXT OHLCV（OKX 永续）
│   ├── okxIndicators.js             # OKX EMA144/169 通道带
│   └── chainlink.js                 # RTDS（SETTLE_SOURCE=chainlink）
├── strategy/
│   ├── vegasChannel.js              # 穿越判定（用 OKX 通道带）
│   ├── vegasState.js                # need_outside / armed / in_chain
│   └── reversalContinuation.js      # 旧策略（回测用）
├── market/polymarket.js             # Gamma：{base}-updown-{tf}-{sec}
├── stats/manager.js                 # 盈亏统计（按实例隔离）
├── trader/
│   ├── executor.js                  # CLOB GTC/FOK；Portfolio / Cash
│   ├── fillSync.js                  # 成交解析
│   ├── restingFillWatcher.js        # GTC 周期内监视
│   └── chainlinkSettle.js           # OKX / Chainlink 结算
├── martingale/
│   ├── manager.js                   # 同向马丁（按实例隔离）
│   ├── bankroll.js                  # 共用 P/N + 动态首注
│   └── dynamicBaseBet.js            # 动态首注辅助
└── utils/
    ├── instancePaths.js             # pending-bet-{id}.json 等
    ├── logger.js / telegram.js …
scripts/
├── run-instance.js                  # 跨平台单实例启动
├── backtest-vegas-1h.js             # 维加斯回测（--timeframe / --symbol / --emaStackFilter）
├── lib/tradingUniverse.cjs          # PM2 标的×周期解析
└── setup-telegram-topics.js         # 论坛话题写入 .env
ecosystem.config.cjs                 # PM2：V3-{base}-{tf}
docs/
└── ARCHITECTURE.md
```

### 日志 / 状态

**全实例共享：**

| 文件 | 说明 |
|------|------|
| `logs/bankroll-state.json` | 共用本金 P、净胜负 N |

**按实例后缀**（`BOT_INSTANCE`，如 `btc-15m` / `eth-5m`）：

| 文件 | 说明 |
|------|------|
| `logs/pending-bet-btc-15m.json` | 待结算注单 |
| `logs/vegas-state-btc-15m.json` | 维加斯相位 |
| `logs/martingale-state-btc-15m.json` | 马丁注码 / 连亏 |
| `logs/settlements-btc-15m.jsonl` | 结算流水 |
| `logs/trades-btc-15m.jsonl` | 下单流水 |
| `logs/signals-btc-15m.jsonl` | 信号流水 |
| `logs/stats-state-btc-15m.json` | 盈亏统计 |
| `logs/heartbeat-btc-15m.json` | 心跳 |
| `logs/bot-btc-15m.log` | Winston 日志 |

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### K 线 / 信号

| 变量 | 默认 | 说明 |
|------|------|------|
| `OHLCV_EXCHANGE` | okx | K 线主交易所 |
| `OHLCV_MARKET_TYPE` | swap | `swap`=USDT 永续；`spot`=现货 |
| `TRADING_SYMBOLS` | BTC | **PM2 多标的列表**（`BTC,ETH` 或 `BTC/USDT,ETH/USDT`） |
| `CANDLE_TIMEFRAMES` | 5m,15m,1h | **PM2 周期列表** |
| `TRADING_SYMBOL` | BTC/USDT | 单进程 slug；PM2 时由 ecosystem 按标的注入 |
| `CANDLE_TIMEFRAME` | 1h | 单进程默认；PM2 时由 ecosystem 覆盖 |
| `MARKET_CYCLE_MINUTES` | 随 timeframe | 可省略，由 `CANDLE_TIMEFRAME` 推导 |
| `BOT_INSTANCE` | = timeframe | 状态文件后缀（PM2 为 `{base}-{tf}`，如 `btc-5m`） |
| `CANDLE_FETCH_LIMIT` | 200 | OHLCV 根数；通道 EMA 由 OKX 指标接口提供 |
| `SIGNAL_DELAY_MS` | 按周期 | 新信号：周期边界后延迟再拉 K（默认 5m→3s / 15m→4s / 1h→5s） |
| `IN_CHAIN_SIGNAL_DELAY_MS` | 100 | `in_chain` 续单延迟（无需等 K 线） |
| `MG_CONT_FAST_PATH` | true | 结算输且未满连亏上限时，立即对下一窗口同向下单 |
| `SIGNAL_DATA_RETRY_MS` | 800 | K 未新鲜 / EMA 未对齐时周期内重试间隔 |
| `SIGNAL_DATA_MAX_WAIT_MS` | 60000 | 周期内等待数据就绪上限（仍预留下单窗口） |
| `PREWARM_MS` | 5000 | 周期边界前提前预热 Gamma / CLOB / 余额 |

### 马丁 / 动态首注 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 10 | 跟上目标线时的默认投入 |
| `MAX_BET_USD` | 30 | 单笔硬上限 |
| `BANKROLL_STEP_USD` | 10 | 目标线步进（目标=本金+净胜负×step） |
| `BANKROLL_CATCHUP_T_CAP` | 20 | 落后时目标净利 T 硬上限 |
| `BANKROLL_CATCHUP_GAP_FULL` | 5 | gap≤此值 → 一次补齐 |
| `BANKROLL_CATCHUP_GAP_HALF` | 15 | gap≤此值 → 补一半 |
| `BANKROLL_CATCHUP_GAP_THIRD` | 30 | 文档阈值；gap>半档 → 补 1/3 |
| `BANKROLL_STAKE_MAX_USD` | 30 | 动态仓位单笔上限 |
| `MARTINGALE_MULTIPLIER` | 1 | 连亏倍数（仓位由动态首注重算） |
| `MARTINGALE_MAX_LOSSES` | 5 | 连亏止损次数 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限（**每实例**） |
| `ORDER_PRICE_CAP` | 0.95 | YES/NO 限价封顶；`.env.example` 推荐 `0.60`；`0`=不限制 |
| `ORDER_TYPE` | GTC | `GTC` 限价 / `FOK` 市价 |
| `DRY_RUN` | false | `true`=模拟下单 |
| `SETTLE_SOURCE` | chainlink | `okx` / `chainlink` |

钱包 / Telegram 见 `.env.example`。

---

## 运行逻辑（单实例）

```
周期边界前 PREWARM：预热 Gamma / CLOB / 余额
周期边界 + 延迟（新信号 SIGNAL_DELAY / in_chain 短延迟）
  │
  ├─ 若有 pending → 拉 K 并结算（输且未 halt → MG_CONT 快路径立刻下下一窗）
  ├─ in_chain：跳过 OHLCV/EMA，同向续单（并行 Gamma + Portfolio）
  ├─ armed：新鲜度检查 + OKX EMA 穿越 → 有信号则下单
  ├─ 风控：日亏损 / Portfolio·Cash
  └─ 成交后登记 pending → 周期结束结算 → 更新马丁 + vegas + 共用 bankroll
```

- **无信号 / 风控拦截**：不下单；`in_chain` 时方向锁定保持  
- **赢**：马丁重置 → `need_outside`；N +1  
- **连亏 5**：止损重置 → `need_outside`；**重新拉取 Portfolio 锁定本金 P，N 重置为 0**（须再等通道外实体；**不会**走快路径续单）  
- **结算输且连亏 &lt; 5**：结算完成后立即同向续下一窗（`MG_CONT_FAST_PATH`）；N −1  
- GTC 未成交不计入马丁 / 不改 N  

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run pm2:start` | 实盘：按 `.env` 的 `TRADING_SYMBOLS` × `CANDLE_TIMEFRAMES` 开齐 |
| `npm run pm2:dry` | 模拟盘同上 |
| `npm run pm2:restart` | 重启全部实例 |
| `npm run pm2:stop` | 停止全部实例 |
| `npm run pm2:logs` | 查看日志 |
| `npm run pm2:btc:start` / `pm2:eth:start` | 只开某一标的三周期（需该标的在 SYMBOLS 内） |
| `npm run start:btc:5m` / `start:eth:5m` 等 | 单进程实盘 |
| `npm run dry:5m` / `dry:15m` / `dry:1h` | 单进程空跑 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 CLOB API 凭证 |
| `npm run setup:tg-topics` | 按 SYMBOLS×TF 创建/写入 Telegram 话题 |
| `node scripts/check-env.js` | 检查配置 |
| `node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01` | 离线回测 |

---

## 回测

```bash
# 与实盘同规则：OKX EMA、动态首注默认 $10、T≤$20、单笔≤$30、连亏 5、入场价 0.50、含手续费
node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01
node scripts/backtest-vegas-1h.js --timeframe=5m --from=2020-01-01 --symbol=ETH/USDT
node scripts/backtest-vegas-1h.js --days=30 --symbol=BTC/USDT

# 可选：EMA 堆叠过滤（多头通道只做 UP / 空头通道只做 DOWN）
node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01 --emaStackFilter=true

# 其它：--base=3 --mult=3 --maxLosses=5 --entry=0.50 --fee=true --force
```

结果写入 `logs/backtest-vegas-{base}-{tf}.json` 与 `*-trades.csv`（`emaStackFilter` 时文件名带 `-emastack`）。

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。

```bash
cp .env.example .env    # 配置私钥 / Telegram / TRADING_SYMBOLS
npm install
npm run pm2:dry         # 先空跑
# 确认无误后
npm run pm2:start
pm2 save && pm2 startup
```

---

## 注意事项

- 钱包需有足够 **pUSD Cash**（≥ `MIN_BALANCE_USD`）；多开时注意多路同时加仓的余额与敞口；本金按 **Portfolio** 锁定与追赶
- 国内：`OHLCV_EXCHANGE=okx`；需访问 `gamma-api.polymarket.com`、`clob.polymarket.com`，以及 OKX 指标接口
- 默认 `SETTLE_SOURCE=chainlink`（需能连 `wss://ws-live-data.polymarket.com`）；改 `okx` 则用永续 K 线结算、可不启 RTDS
- 首次务必 `DRY_RUN` / `pm2:dry` 确认信号与 slug 正常后再实盘
- 若曾跑过旧标的或改过 `TRADING_SYMBOLS`，先 `pm2 delete all` 再 `pm2:start`（实例名形如 `V3-btc-*` / `V3-eth-*`）
- 重置共用本金：删除或编辑 `logs/bankroll-state.json`（谨慎操作）
- `.env` 中旧版 `SESSION_GATE_*`、`ACTIVITY_*`、`VOLATILITY_*` 等实盘不再读取，可删除
