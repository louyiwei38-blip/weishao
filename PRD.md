# PRD - Polymarket 趋势反转延续交易机器人

**版本号：** 2.2  
**日期：** 2026-06-03  
**技术栈：** Node.js + CCXT + Polymarket CLOB V2  
**策略代号：** Reversal Continuation（反转延续）

---

## 1. 产品概述

构建一个**规则驱动**的自动化交易机器人，实现以下功能：

1. 通过 CCXT 从币安拉取 **BTC/USDT 5 分钟** OHLCV（K 线）数据
2. 在每根 5 分钟 K 线**收盘确认**后，根据「上根 + 当根」形态判断**下一根**方向
3. 基于预测结果在 Polymarket **BTC 涨跌 5 分钟**预测市场中使用 CLOB V2 API 执行交易（看涨买 YES，看跌买 NO）
4. 无信号时不交易；仓位持有至市场自动结算，不主动平仓
5. 采用**马丁格尔**仓位管理：连续预测错误后按倍数加大下一笔下注；预测正确或达到最大连亏次数后重置为基础金额

**策略一句话：** 出现趋势反转（阳→阴 或 阴→阳）后，押注反转方向在**紧接着的下一根 5m K 线**上延续。

---

## 2. 背景与动机

Polymarket 托管与现货周期对齐的 **5 分钟 BTC 涨跌**二元预测市场（`https://polymarket.com/zh/crypto/5M`）。这类市场以概率（0–1）定价，规则引擎输出的方向性判断可直接转化为 YES/NO 仓位。

本策略不依赖 LLM，而是用可回测、可复现的 K 线形态规则，在**每根 5m K 收盘瞬间**产生下一周期的方向信号，与 Polymarket 新开盘的 5 分钟窗口一一对应。马丁格尔用于在连续亏损后放大下注，单次盈利可覆盖此前连亏序列（受 `MAX_BET_USD` 与止损次数约束）。

**与旧版 PRD（v1.2）的差异：**

| 维度 | v1.2 | v2.2（本 PRD） |
|------|------|----------------|
| 信号来源 | DeepSeek 多周期 AI | 固定规则（反转延续） |
| 交易标的 | 多交易对、多周期 | 仅 BTC/USDT × 5m |
| 置信度 | `MIN_CONFIDENCE` 过滤 | 无；有信号即满足形态 |
| 触发逻辑 | 周期开始即跑 AI | **K 收盘后**判定，再进下一 Polymarket 窗口 |

---

## 3. 策略定义（核心）

### 3.1 K 线分类

以币安 **5m** OHLCV 为准（与 Polymarket 5 分钟窗口对齐，时区 **UTC**）：

| 类型 | 条件 |
|------|------|
| **阳线** | `close > open` |
| **阴线** | `close < open` |
| **十字线 / 平盘** | `close === open` → **不产生信号** |

记：

- **K[-2]**：上一根已收盘 K 线（相对触发时刻的前一根）
- **K[-1]**：刚收盘的那根 K 线（当前已完成根）
- **K[0]**：下一根待预测 K 线（对应即将参与的 Polymarket 5m 窗口）

> 在 UTC `:00/:05/:10/:15/:20/:25/:30/:35/:40/:45/:50/:55` 触发时，**K[-1]** 为刚结束的 5 分钟，**K[-2]** 为其前一根。

### 3.2 信号规则

| 编号 | K[-2]（上根） | K[-1]（当根，已收盘） | 对 K[0]（下一根）的预测 | Polymarket 操作 |
|------|---------------|----------------------|-------------------------|-----------------|
| **S1** | 阳线 | 阴线 | 下一根为**阴线**（延续下跌） | 买 **NO**（看跌） |
| **S2** | 阴线 | 阳线 | 下一根为**阳线**（延续上涨） | 买 **YES**（看涨） |
| — | 其他组合 | — | **无信号，不下单** | — |

**语义：** 上一段趋势与当根相反 → 视为**反转**；押注反转后的方向在**紧接着的下一根 5m** 上继续。

### 3.3 信号示例

```
时间轴 (UTC 5m):

  K[-2]      K[-1]       K[0] ← 对应的 Polymarket 窗口
  阳线   →   阴线   →   预测阴线 → 买 NO
  阴线   →   阳线   →   预测阳线 → 买 YES
```

### 3.4 明确不做的事

- 不使用 AI / 置信度打分
- 不对「阳+阳」「阴+阴」等同向组合下单
- 十字线参与任一侧时，整笔信号作废
- 不在同一 Polymarket 5m 市场重复下单

---

## 4. 关键技术约束

### 4.1 Polymarket CLOB V2

| 参数 | 值 |
|------|-----|
| SDK | `@polymarket/clob-client-v2` |
| CLOB 服务地址 | `https://clob-v2.polymarket.com` |
| Gamma 市场发现接口 | `https://gamma-api.polymarket.com/markets` |
| 链 | Polygon 主网（chainId 137） |
| 抵押品 | **pUSD**（通过 Collateral Onramp `wrap()` 由 USDC.e 转换） |
| 交易所合约地址 | `0xE111180000d2663C0091e4f400237545B87B996B` |
| EIP-712 版本 | `"2"` |
| 订单唯一性 | `timestamp`（毫秒）替代旧版 `nonce` |
| 手续费模型 | 每市场动态费率：`fee = C x feeRate x p x (1-p)`，通过 `getClobMarketInfo()` 查询 |
| 订单类型 | GTC（限价单）/ FOK（市价全成或撤销） |
| 鉴权请求头 | `POLY_ADDRESS`、`POLY_SIGNATURE`、`POLY_TIMESTAMP`、`POLY_API_KEY`、`POLY_PASSPHRASE` |

**V2 订单结构（简化）：**

```
{ tokenID, price, size, side: "BUY"|"SELL", expiration, timestamp, metadata, builder }
```

`feeRateBps`、`nonce`、`taker` 字段在 V2 中已**移除**。

**市价订单结构：**

```
{ tokenID, amount, side, orderType: "FOK", userUSDCBalance?, builderCode? }
```

**方向映射：**

| 预测下一根 | Token |
|------------|-------|
| 阳线（涨） | 买 **YES** |
| 阴线（跌） | 买 **NO** |

### 4.2 CCXT（币安 OHLCV）

- 安装：`npm install ccxt`
- 初始化交易所：`new ccxt.binance({ enableRateLimit: true })`
- 获取 K 线：`exchange.fetchOHLCV("BTC/USDT", "5m", since, limit)`
- 返回格式：`[ [timestamp, open, high, low, close, volume], ... ]`
- **公开接口** — 拉取 OHLCV 无需 API Key

### 4.3 已移除的依赖

- ~~DeepSeek API~~
- ~~`openai` SDK~~
- ~~多时间周期并行预测~~
- ~~多交易对并行执行~~

---

## 5. 功能需求

### FR-1：数据采集模块（CCXT 拉取币安 OHLCV）

| 编号 | 需求描述 |
|------|----------|
| FR-1.1 | 固定交易对：`BTC/USDT` |
| FR-1.2 | 固定时间周期：`5m` |
| FR-1.3 | 每次信号评估拉取最近 N 根 K 线（默认 N=5，至少需 3 根已收盘） |
| FR-1.4 | 仅使用**已收盘** K 线；以 `timestamp`（开盘时间）与 UTC 5m 边界对齐，禁止误用未收盘的当前根 |
| FR-1.5 | 将 OHLCV 标准化为结构化 JSON，供信号模块使用 |
| FR-1.6 | 使用 `enableRateLimit: true`；网络异常时指数退避重试，最多 3 次 |

### FR-2：信号引擎模块（规则，替代 AI）

| 编号 | 需求描述 |
|------|----------|
| FR-2.1 | 输入：最近若干根 5m OHLCV（仅已收盘） |
| FR-2.2 | 实现 `classifyCandle(candle) → BULL \| BEAR \| DOJI` |
| FR-2.3 | 实现 `evaluateReversalContinuation(kMinus2, kMinus1) → UP \| DOWN \| NONE` |
| FR-2.4 | **S1**：`BULL + BEAR → DOWN`；**S2**：`BEAR + BULL → UP`；其余 → `NONE` |
| FR-2.5 | 输出合法结构化 JSON，写入 `logs/signals.jsonl` |
| FR-2.6 | `NONE` 时跳过后续下单，记录 INFO 日志 |

**信号输出示例：**

```json
{
  "symbol": "BTC/USDT",
  "timeframe": "5m",
  "evaluatedAt": "2026-06-03T10:15:00.000Z",
  "kMinus2": { "t": 1717412400000, "o": 67500, "c": 67620, "type": "BULL" },
  "kMinus1": { "t": 1717413300000, "o": 67620, "c": 67480, "type": "BEAR" },
  "signal": "DOWN",
  "signalId": "S1",
  "reason": "prev=BULL, curr=BEAR → predict next BEAR"
}
```

### FR-3：市场发现与周期检测模块（Polymarket Gamma API）

**目标市场：** `https://polymarket.com/zh/crypto/5M`（Polymarket 加密货币 **BTC 5 分钟**预测市场）

| 编号 | 需求描述 |
|------|----------|
| FR-3.1 | 查询 `https://gamma-api.polymarket.com/markets` 获取活跃的加密货币 5 分钟预测市场 |
| FR-3.2 | 筛选条件：`category=crypto`、`active=true`、周期 5 分钟、标的为 **BTC**、未到期 |
| FR-3.3 | **触发时机**：UTC 每 5 分钟整点（`:00`/`:05`/…`/`:55`），在 K[-1] 收盘确认后执行（建议延迟 `SIGNAL_DELAY_MS`） |
| FR-3.4 | 绑定**下一窗口**市场：`endTime ≈ 当前边界 + 5min`（即 K[0] 对应的 Polymarket 轮次） |
| FR-3.5 | 调用 `getClobMarketInfo()` 获取 YES/NO token ID 和动态手续费率 |
| FR-3.6 | 市场列表 TTL 缓存（每轮周期刷新一次） |

### FR-4：交易执行模块（Polymarket CLOB V2）

| 编号 | 需求描述 |
|------|----------|
| FR-4.1 | 使用 `@polymarket/clob-client-v2`，以 options 对象方式初始化 `ClobClient` |
| FR-4.2 | 通过环境变量 `POLY_ADDRESS`、`POLY_API_KEY`、`POLY_PASSPHRASE` 完成鉴权 |
| FR-4.3 | 首次交易前通过 Collateral Onramp 将 USDC.e 换成 pUSD（先检查余额） |
| FR-4.4 | `signal=UP` → 买入 YES；`signal=DOWN` → 买入 NO；`signal=NONE` → 不下单 |
| FR-4.5 | 下单金额 = `martingale.getBetSize("BTC/USDT:5m")`，受 `MAX_BET_USD` 与 pUSD 余额约束 |
| FR-4.6 | 下单前若该轨 `isHalted=true`（刚触发马丁止损），本周期跳过下单，下一周期以重置后的基础注重新开始 |
| FR-4.7 | 默认使用 `OrderType.FOK`，可通过 `ORDER_TYPE=GTC` 切换为限价单 |
| FR-4.8 | 市价买单传入 `userUSDCBalance`，用于计算含手续费的实际成交量 |
| FR-4.9 | 同一 `(conditionId, cycleStartTs)` 防止重复下单 |
| FR-4.10 | 订单日志记录：`orderId`、`signal`、`signalId`、`baseBet`、`actualBet`、`consecutiveLosses`、时间戳 |

### FR-5：Bot 调度与编排

| 编号 | 需求描述 |
|------|----------|
| FR-5.1 | **主触发器**：UTC 每 5 分钟整点（`:00`/`:05`/…`/`:55`），与 5m K 收盘对齐 |
| FR-5.2 | 边界后延迟 `SIGNAL_DELAY_MS`（默认 10s）再拉 OHLCV，确保交易所已写入收盘数据 |
| FR-5.3 | 每轮流程：拉取 OHLCV → 信号评估 →（有信号）市场发现 → 马丁取注 → 下单 |
| FR-5.4 | **不主动平仓**：仓位持有至 Polymarket 市场自动结算 |
| FR-5.5 | 支持 `DRY_RUN=true`：全链路运行但不提交真实订单 |
| FR-5.6 | SIGINT/SIGTERM 优雅退出，刷新待写日志 |
| FR-5.7 | 结构化控制台日志：DEBUG、INFO、WARN、ERROR |
| FR-5.8 | 市场结算后异步轮询 `resolved`，调用 `martingale.onSettled(win\|loss)` 更新状态 |

---

## 6. 非功能需求

| 类别 | 需求描述 |
|------|----------|
| **可靠性** | API 调用失败时最多重试 3 次，指数退避 |
| **安全止损** | 当日已实现亏损超过 `MAX_DAILY_LOSS_USD`（默认 $50）时自动停止 |
| **安全止损** | pUSD 余额低于 `MIN_BALANCE_USD`（默认 $20）时不允许下单 |
| **安全性** | 所有密钥仅从 `.env` 加载，严禁硬编码 |
| **性能** | 完整周期（拉取 + 信号 + 下单）须在 **30 秒**内完成 |
| **可观测性** | 每次信号、每次下单、马丁状态变更均记录到带时间戳的日志文件 |
| **可回测** | 信号逻辑为纯函数，便于离线历史回测 |
| **可移植性** | Node.js 18+，`npm install` 完成依赖安装 |

---

## 7. 系统架构

```
┌─────────────────────────────────────────────────────────────────┐
│   周期触发器（UTC :00/:05/:10/:15/:20/:25/:30/:35/:40/:45/:50/:55 + SIGNAL_DELAY_MS 延迟）        │
└────────────────────────────┬────────────────────────────────────┘
                             ▼
                  ┌──────────────────────┐
                  │   CCXT 币安 5m OHLCV │
                  │   取 K[-2], K[-1]     │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  反转延续信号引擎     │
                  │  S1/S2 → UP/DOWN     │
                  │  其他 → NONE         │
                  └──────────┬───────────┘
                             │ signal ≠ NONE
                             ▼
                  ┌──────────────────────┐
                  │  Gamma：BTC 5M 市场  │
                  │  getClobMarketInfo   │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  马丁格尔取注金额     │
                  │  manager.getBetSize  │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  CLOB V2 下单 FOK    │
                  │  UP→YES / DOWN→NO   │
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  持仓至自动结算       │
                  │  onSettled → 马丁更新 │
                  │  logs/ 审计落盘       │
                  └──────────────────────┘
```

---

## 8. 文件与模块结构

```
polymarket-reversal-bot/
├── src/
│   ├── index.js                         # 入口：UTC 5m 边界调度
│   ├── config.js                        # .env + 默认值
│   ├── collector/
│   │   └── binance.js                   # CCXT BTC/USDT 5m OHLCV
│   ├── strategy/
│   │   └── reversalContinuation.js      # 信号纯函数 S1/S2
│   ├── market/
│   │   └── polymarket.js                # Gamma 发现 + CLOB 缓存
│   ├── trader/
│   │   └── executor.js                  # CLOB V2 订单执行
│   ├── martingale/
│   │   └── manager.js                   # 马丁格尔状态机 + 持久化
│   └── utils/
│       ├── logger.js
│       └── retry.js
├── logs/
│   ├── signals.jsonl
│   ├── trades.jsonl
│   └── martingale-state.json
├── .env.example
├── package.json
└── README.md
```

---

## 9. 环境变量

```bash
# .env.example

# Polymarket V2
POLY_ADDRESS=0x...                    # Polygon 钱包地址
POLY_PRIVATE_KEY=0x...                # 钱包私钥（订单签名）
POLY_API_KEY=...                      # Polymarket API Key
POLY_PASSPHRASE=...                   # API 密码短语
POLY_BUILDER_CODE=0x...               # 可选：Builder 归因代码

# 币安（可选 — OHLCV 为公开接口）
BINANCE_API_KEY=
BINANCE_SECRET=

# 策略（固定 BTC 5m）
TRADING_SYMBOL=BTC/USDT
CANDLE_TIMEFRAME=5m
CANDLE_FETCH_LIMIT=5
SIGNAL_DELAY_MS=10000                 # K 收盘后延迟拉取（毫秒）

# Bot
MARKET_CYCLE_MINUTES=5
TRADE_BUDGET_USD=10                   # 马丁基础下注 / 重置金额
MAX_DAILY_LOSS_USD=50
MIN_BALANCE_USD=20
MAX_BET_USD=200                       # 单笔硬上限
ORDER_TYPE=FOK                        # FOK | GTC
DRY_RUN=false
LOG_LEVEL=INFO                        # DEBUG | INFO | WARN | ERROR

# 马丁格尔（单轨 BTC/USDT:5m）
MARTINGALE_MULTIPLIER=2
MARTINGALE_MAX_LOSSES=4

# 风控（可选）
SKIP_IF_YES_PRICE_OUT_OF_RANGE=true
YES_PRICE_MIN=0.05
YES_PRICE_MAX=0.95
```

---

## 10. 核心数据流

### 10.1 OHLCV 数据采集（CCXT）

```
binance.fetchOHLCV("BTC/USDT", "5m", undefined, 5)
  => [[ts, open, high, low, close, volume], ...]
  => 取倒数第 2、第 1 根作为 K[-2]、K[-1]（均已收盘）
```

### 10.2 信号评估

```javascript
function classifyCandle({ open, close }) {
  if (close > open) return 'BULL';
  if (close < open) return 'BEAR';
  return 'DOJI';
}

function evaluateReversalContinuation(prev, curr) {
  const p = classifyCandle(prev);
  const c = classifyCandle(curr);
  if (p === 'BULL' && c === 'BEAR') return { signal: 'DOWN', signalId: 'S1' };
  if (p === 'BEAR' && c === 'BULL') return { signal: 'UP',   signalId: 'S2' };
  return { signal: 'NONE' };
}
```

### 10.3 与 Polymarket 窗口对齐

| 时刻 (UTC) | 币安 K 线 | Bot 行为 |
|------------|-----------|----------|
| 10:10:10 | K[-1] = 10:05–10:10 已收盘 | 读 K[-2]=10:00–10:05，K[-1]=10:05–10:10 → 若有信号，参与 **10:10–10:15** Polymarket 轮次 |

### 10.4 下单（含马丁）

```javascript
const key = 'BTC/USDT:5m';
const { actualBet, skipReason } = martingale.prepareOrder(key);
if (skipReason || signal === 'NONE') return;

const tokenID = signal === 'UP' ? yesTokenId : noTokenId;

await client.createMarketOrder({
  tokenID,
  amount: actualBet,
  side: Side.BUY,
  orderType: OrderType.FOK,
  userUSDCBalance: balance
});

// 市场 resolved 后:
// martingale.onSettled(key, won);
```

---

## 11. 马丁格尔策略详细设计

### 11.1 概念

马丁格尔策略的核心是：**每次预测错误（结算输）后将下注金额按倍数放大；预测正确或触达最大连亏次数后重置为基础金额**。

本 Bot 每个 5m 周期最多 0 或 1 笔信号，马丁状态按单轨 **`BTC/USDT:5m`** 维护。

### 11.2 策略参数（全部可配置）

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| 基础下注金额 | `TRADE_BUDGET_USD` | `10` | 连亏清零后的 USDC 金额 |
| 亏损翻倍倍数 | `MARTINGALE_MULTIPLIER` | `2` | 每次连续亏损后的下注倍数 |
| 最大连续亏损次数 | `MARTINGALE_MAX_LOSSES` | `4` | 达到后止损重置 |
| 单笔下注上限 | `MAX_BET_USD` | `200` | 无论翻倍到多少都不超过 |

### 11.3 状态机

```
State {
  key: "BTC/USDT:5m",
  consecutiveLosses: number,
  currentBet: number,
  isHalted: boolean
}
```

**状态转移规则：**

```
初始: consecutiveLosses=0, currentBet=TRADE_BUDGET_USD, isHalted=false

有信号且准备下单:
  if isHalted → 本周期不下单；isHalted=false；currentBet=TRADE_BUDGET_USD；consecutiveLosses=0
  else → actualBet = min(currentBet, MAX_BET_USD, availableBalance)

结算赢（预测方向与 5m 实际涨跌一致）:
  consecutiveLosses = 0
  currentBet = TRADE_BUDGET_USD
  isHalted = false

结算输:
  consecutiveLosses += 1
  if consecutiveLosses >= MARTINGALE_MAX_LOSSES:
    isHalted = true
    log WARN: "Martingale stop-loss triggered"
    consecutiveLosses = 0
    currentBet = TRADE_BUDGET_USD
  else:
    currentBet = currentBet * MARTINGALE_MULTIPLIER
```

### 11.4 下注金额序列示例（base=$10, multiplier=2, maxLosses=4）

| 轮次 | 连续亏损次数 | 下注金额 | 事件 |
|------|--------------|----------|------|
| 1 | 0 | $10 | 开局基础注 |
| 2 | 1 | $20 | 第 1 次亏损，翻倍 |
| 3 | 2 | $40 | 第 2 次亏损，翻倍 |
| 4 | 3 | $80 | 第 3 次亏损，翻倍 |
| 5 | 4 | — | 第 4 次亏损，**触发止损**，重置 |
| 6 | 0 | $10 | 重置后新一轮基础注 |

> **单轨最大理论连亏敞口**（maxLosses=4）：$10 + $20 + $40 + $80 = **$150**

### 11.5 状态持久化

- 写入 `logs/martingale-state.json`，每次 `onSettled` 或下单后即时落盘
- Bot 重启后从该文件恢复

```json
{
  "BTC/USDT:5m": {
    "consecutiveLosses": 2,
    "currentBet": 40,
    "isHalted": false
  }
}
```

### 11.6 与信号引擎的关系

| 场景 | 马丁行为 |
|------|----------|
| `signal=NONE` | **不更新**马丁状态 |
| 有信号且成功下单 | 用 `currentBet` 下单；结算后 `onSettled` |
| 有信号但风控跳过 | 不下单，**不计**连亏 |
| 触发 `isHalted` 后首个有信号周期 | 跳过下单并重置为基础注 |

### 11.7 结算判断逻辑

以币安对应 5m 窗口为准（开发前核对 Polymarket resolution 文案是否一致）：

| 持仓 | 该 5m `close` vs `open` | 结果 |
|------|--------------------------|------|
| YES（signal=UP） | `close > open` | **赢** → 重置马丁 |
| YES | `close < open` | **输** → 翻倍/止损 |
| NO（signal=DOWN） | `close < open` | **赢** |
| NO | `close > open` | **输** |
| 任意 | `close === open` | **平** → 马丁状态**不变**（不计赢不计亏） |

- 通过轮询 `GET /markets/{conditionId}` 的 `resolved` 字段检测 Polymarket 结算，并与币安 OHLCV 交叉校验

---

## 12. 风险管理规则

| 规则 | 逻辑 |
|------|------|
| **无信号** | `signal === NONE` 时跳过下单，不改变马丁计数 |
| **十字线** | K[-2] 或 K[-1] 为 DOJI → 无信号 |
| **每日亏损上限** | 累计当日 UTC 已实现亏损超过 `MAX_DAILY_LOSS_USD` 时停止运行 |
| **马丁格尔止损** | 连亏达 `MARTINGALE_MAX_LOSSES` 后重置并记录 WARN |
| **最低余额保护** | pUSD < `MIN_BALANCE_USD` 时跳过 |
| **单笔下注上限** | `actualBet = min(currentBet, MAX_BET_USD, balance)` |
| **防重复下单** | 追踪 `(conditionId, cycleStartTs)` |
| **价格合理性** | YES 价不在 [0.05, 0.95] 时可跳过（可配置） |
| **数据新鲜度** | K[-1] 的 `timestamp` 必须等于本周期开盘时间，否则 WARN 并跳过 |

---

## 13. 结算与绩效统计

| 项目 | 说明 |
|------|------|
| **胜率** | 有信号且已结算订单中赢的比例 |
| **信号频率** | S1 / S2 / NONE 各计数 |
| **PnL** | 按日汇总已实现盈亏 |
| **马丁轨状态** | 当前 `consecutiveLosses`、`currentBet` |

---

## 14. 开发里程碑

| 阶段 | 里程碑 | 交付物 |
|------|--------|--------|
| **Phase 1** | 项目脚手架 | `package.json`、`.env.example`、模块骨架、日志工具 |
| **Phase 2** | 数据采集 | BTC 5m OHLCV、收盘校验、单元测试 |
| **Phase 3** | 信号引擎 | `reversalContinuation.js`、S1/S2/无信号/十字测试 |
| **Phase 4** | 市场发现 | Gamma BTC 5M、窗口绑定、CLOB 缓存 |
| **Phase 5** | 交易执行 | CLOB V2 鉴权、pUSD 检查、FOK 下单 |
| **Phase 6** | 风控与编排 | 每日亏损上限、DRY_RUN、调度器、优雅退出 |
| **Phase 6a** | 马丁格尔引擎 | `manager.js`、状态持久化、结算轮询 |
| **Phase 7** | 测试与加固 | 历史回测脚本、测试网空跑 |

---

## 15. 依赖清单

```json
{
  "dependencies": {
    "ccxt": "^4.5.51",
    "@polymarket/clob-client-v2": "latest",
    "viem": "^2.x",
    "dotenv": "^16.x",
    "winston": "^3.x"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## 16. 待决策问题

| 编号 | 问题 | 决策 / 建议 |
|------|------|-------------|
| ~~Q1~~ | 目标市场？ | **✅** Polymarket **BTC 5 分钟**涨跌市场 |
| ~~Q2~~ | 是否保留马丁格尔？ | **✅ 保留**；单轨 `BTC/USDT:5m`；**4 连亏止损**（`MARTINGALE_MAX_LOSSES=4`） |
| ~~Q3~~ | 限价还是市价？ | **✅** 默认 `FOK`，可 `ORDER_TYPE=GTC` |
| ~~Q4~~ | 是否主动平仓？ | **✅ 否**；持有至自动结算 |
| **Q5** | K 收盘后延迟多久拉 OHLCV？ | 默认 `SIGNAL_DELAY_MS=10000` |
| **Q6** | 5m 平盘（十字）结算？ | 默认：**马丁不变**，不计赢不计亏 |
| **Q7** | Polymarket resolution 与币安 OHLCV 是否完全一致？ | 开发前核对 market 文案 |

---

## 17. 验收标准（Acceptance Criteria）

1. UTC 5m 边界 + 延迟后，能正确识别 K[-2]/K[-1] 阴阳形态。  
2. **S1**（阳→阴）仅触发买 NO；**S2**（阴→阳）仅触发买 YES。  
3. 阳+阳、阴+阴、含十字等组合**零下单**。  
4. 每轮最多一笔 BTC 5M 订单，且绑定**下一** 5 分钟窗口。  
5. 连亏后下一笔金额为翻倍后的 `currentBet`，且 ≤ `MAX_BET_USD`。  
6. 预测正确后下一笔恢复 `TRADE_BUDGET_USD`。  
7. 连亏 4 次触发止损，下一有信号周期从基础注重新开始。  
8. `signal=NONE` 周期不改变 `martingale-state.json`。  
9. `DRY_RUN=true` 下全链路可跑通并落盘 `signals.jsonl`。

---

*PRD v2.2 — 策略：趋势反转并延续；标的：BTC 5 分钟 Polymarket（`crypto/5M`）；马丁：$10 起 ×2、4 连亏止损。定稿，可开始 Phase 1 开发。*
