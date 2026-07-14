# Polymarket Vegas Channel Bot

OKX USDT 永续 K 线 · EMA144/EMA169 维加斯通道穿越入场 · 同向马丁 **$3 ×3 / 连亏 5** · **BTC + ETH × 5m/15m/1h 六实例并行** · CLOB V2 · OKX/Chainlink 结算 · GTC 限价

Polymarket **BTC / ETH** 的 **5 分钟 / 15 分钟 / 1 小时**涨跌盘口可同时运行：各拉对应周期 OKX 永续 K 线，按维加斯通道穿越产生信号；CLOB 限价/市价下单；默认 **Chainlink** 结算；同向马丁管理仓位。状态文件按实例隔离，互不覆盖。

> 架构细节见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** · 部署见 **[DEPLOY.md](./DEPLOY.md)**

---

## 策略

通道：`lower = min(EMA144, EMA169)`，`upper = max(EMA144, EMA169)`。

| 条件 | 信号 | 操作 |
|------|------|------|
| 上一根实体完全在通道上方 + 本根影线入通道（`low ≤ upper`） | **VG_UP** | 下一周期买涨（YES） |
| 上一根实体完全在通道下方 + 本根影线入通道（`high ≥ lower`） | **VG_DOWN** | 下一周期买跌（NO） |
| 其它 | NONE | 跳过 |

**状态机：**

1. `need_outside` — 等待至少一根已收盘 K **实体完全在通道外**，才进入 `armed`
2. `armed` — 检测穿越入场；有信号则锁定方向进入 `in_chain` 并下首注
3. `in_chain` — **不做新信号检测**；每周期同向续下（马丁 ×3）
4. 赢 → 停止并回 `need_outside`；连亏 5 次 → 止损重置并回 `need_outside`

**安全闸门（下单前）：**

- 上笔 `pending-bet` 未结算 → 本周期不下单
- 仍有 GTC 挂单在监视中 → 本周期不下单（避免叠单）

> K 线默认 **OKX BTC/USDT:USDT 永续**（`OHLCV_MARKET_TYPE=swap`），可与 `TRADING_SYMBOL`（Polymarket slug）分离配置。

不使用 AI。旧版 5m 反转策略仅保留在 `src/strategy/reversalContinuation.js`（回测脚本用）。

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

# 推荐：PM2 同时跑 BTC+ETH × 5m/15m/1h
npm run pm2:dry               # 模拟盘六开
npm run pm2:start             # 实盘六开
pm2 logs

# 或单实例
npm run dry:5m
npm run start:btc:5m
npm run start:eth:1h
```

---

## 多实例 → PM2 现为 BTC/ETH 六开（× 5m/15m/1h）

| PM2 进程 | 周期 | 盘口 slug 示例 |
|----------|------|----------------|
| `V3-btc-5m` 等 | 5 分钟 | `btc-updown-5m-<unix>` |
| `V3-btc-15m` 等 | 15 分钟 | `btc-updown-15m-<unix>` |
| `V3-eth-1h` 等 | 1 小时 | `ethereum` / `btc` 等 1h ET slug |

- 共用同一 `.env` 钱包 / CLOB 凭证
- `BOT_INSTANCE` + `CANDLE_TIMEFRAME` 隔离状态与日志
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
│   └── chainlink.js                 # RTDS（SETTLE_SOURCE=chainlink）
├── strategy/
│   ├── vegasChannel.js              # EMA144/169 穿越判定
│   ├── vegasState.js                # need_outside / armed / in_chain
│   └── reversalContinuation.js      # 旧策略（回测用）
├── market/polymarket.js             # Gamma：{base}-updown-{tf}-{sec}
├── stats/manager.js                 # 盈亏统计（按实例隔离）
├── trader/
│   ├── executor.js                  # CLOB GTC/FOK
│   ├── fillSync.js                  # 成交解析
│   ├── restingFillWatcher.js        # GTC 周期内监视
│   └── chainlinkSettle.js           # OKX / Chainlink 结算
├── martingale/manager.js            # 同向马丁（按实例隔离）
└── utils/
    ├── instancePaths.js             # pending-bet-{id}.json 等
    ├── logger.js / telegram.js …
scripts/
├── run-instance.js                  # 跨平台单实例启动
├── backtest-vegas-1h.js             # 维加斯回测（--timeframe=5m|15m|1h）
└── test-cycle.js
ecosystem.config.cjs                 # PM2：V3-15m + V3-5m
docs/
└── ARCHITECTURE.md
```

### 日志 / 状态（按实例后缀）

| 文件 | 说明 |
|------|------|
| `logs/pending-bet-15m.json` | 待结算注单 |
| `logs/vegas-state-15m.json` | 维加斯相位 |
| `logs/martingale-state-15m.json` | 马丁注码 |
| `logs/settlements-15m.jsonl` | 结算流水 |
| `logs/trades-15m.jsonl` | 下单流水 |
| `logs/signals-15m.jsonl` | 信号流水 |
| `logs/stats-state-15m.json` | 盈亏统计 |
| `logs/heartbeat-15m.json` | 心跳 |
| `logs/bot-15m.log` | Winston 日志 |

（`5m` 同理，后缀改为 `-5m`。）

---

## 关键环境变量

完整注释见 [.env.example](./.env.example)。

### K 线 / 信号

| 变量 | 默认 | 说明 |
|------|------|------|
| `OHLCV_EXCHANGE` | okx | K 线主交易所 |
| `OHLCV_MARKET_TYPE` | swap | `swap`=USDT 永续；`spot`=现货 |
| `TRADING_SYMBOL` | BTC/USDT | Polymarket slug + 结算标的 |
| `CANDLE_TIMEFRAME` | 1h | 单进程默认；PM2 双开时由 ecosystem 覆盖 |
| `MARKET_CYCLE_MINUTES` | 随 timeframe | 可省略，由 `CANDLE_TIMEFRAME` 推导 |
| `BOT_INSTANCE` | = timeframe | 状态文件后缀 |
| `CANDLE_FETCH_LIMIT` | 200 | EMA169 需 ≥170 |
| `SIGNAL_DELAY_MS` | 按周期 | 新信号：周期边界后延迟再拉 K（默认 5m→3s / 15m→4s / 1h→5s） |
| `IN_CHAIN_SIGNAL_DELAY_MS` | 300 | `in_chain` 续单延迟（无需等 K 线） |
| `MG_CONT_FAST_PATH` | true | 结算输且未满连亏上限时，立即对下一窗口同向下单 |
| `SIGNAL_DATA_RETRY_MS` | 800 | K 未新鲜 / EMA 未对齐时周期内重试间隔 |
| `SIGNAL_DATA_MAX_WAIT_MS` | 60000 | 周期内等待数据就绪上限（仍预留下单窗口） |

### 马丁 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 3 | 首注 |
| `MARTINGALE_MULTIPLIER` | 3 | 连亏倍数 |
| `MARTINGALE_MAX_LOSSES` | 5 | 连亏止损次数 |
| `MAX_DAILY_LOSS_USD` | 10000 | 日亏损上限（**每实例**） |
| `MAX_BET_USD` | 10000 | 单笔上限 |
| `ORDER_PRICE_CAP` | 0.95 | YES/NO 限价封顶；`0`=不限制 |
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
  ├─ in_chain：跳过 OHLCV/EMA，同向续单（并行 Gamma+余额）
  ├─ armed：新鲜度检查 + OKX EMA 穿越 → 有信号则下单
  ├─ 风控：日亏损 / 余额
  └─ 成交后登记 pending → 周期结束结算 → 更新马丁 + vegas
```

- **无信号 / 风控拦截**：不下单；`in_chain` 时方向锁定保持  
- **赢**：马丁重置 → `need_outside`  
- **连亏 5**：止损重置 → `need_outside`（须再等通道外实体；**不会**走快路径续单）  
- **结算输且连亏 &lt; 5**：结算完成后立即同向续下一窗（`MG_CONT_FAST_PATH`）  
- GTC 未成交不计入马丁  

---

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run pm2:start` | 实盘六开 **BTC+ETH × 5m/15m/1h** |
| `npm run pm2:dry` | 模拟盘六开 |
| `npm run pm2:restart` | 重启全部实例 |
| `npm run pm2:stop` | 停止全部实例 |
| `npm run pm2:logs` | 查看日志 |
| `npm run pm2:btc:start` / `pm2:eth:start` | 只开某一标的三周期 |
| `npm run start:btc:5m` / `start:eth:5m` 等 | 单进程实盘 |
| `npm run dry:5m` / `dry:15m` / `dry:1h` | 单进程空跑 |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 CLOB API 凭证 |
| `node scripts/check-env.js` | 检查配置 |
| `node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01` | 离线回测 |

---

## 回测

```bash
# 与实盘同规则：首注 $3、×3、连亏 5、入场价 0.50、含手续费
node scripts/backtest-vegas-1h.js --timeframe=15m --from=2020-01-01
node scripts/backtest-vegas-1h.js --timeframe=5m --from=2020-01-01
node scripts/backtest-vegas-1h.js --timeframe=1h --from=2020-01-01

# 可选：--base=3 --mult=3 --maxLosses=5 --entry=0.50 --fee=true
```

结果写入 `logs/backtest-vegas-{tf}.json` 与 `*-trades.csv`。

---

## 部署

详见 **[DEPLOY.md](./DEPLOY.md)**。

```bash
cp .env.example .env    # 配置私钥 / Telegram
npm install
npm run pm2:dry         # 先空跑
# 确认无误后
npm run pm2:start
pm2 save && pm2 startup
```

---

## 注意事项

- 钱包需有足够 **pUSD**（≥ `MIN_BALANCE_USD`）；六开时注意多路马丁同时加仓的余额与敞口
- 国内：`OHLCV_EXCHANGE=okx`；需访问 `gamma-api.polymarket.com` 与 `clob.polymarket.com`
- 默认 `SETTLE_SOURCE=chainlink`（需能连 `wss://ws-live-data.polymarket.com`）；改 `okx` 则用永续 K 线结算、可不启 RTDS
- 首次务必 `DRY_RUN` / `pm2:dry` 确认信号与 slug 正常后再实盘
- 若曾跑过旧标的（SOL/BNB 等），先 `pm2 delete all` 再 `pm2:start`（实例名已变为 `V3-btc-*` / `V3-eth-*`）
- `.env` 中旧版 `SESSION_GATE_*`、`ACTIVITY_*`、`VOLATILITY_*` 等实盘不再读取，可删除
