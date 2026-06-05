# Polymarket Reversal Continuation Bot

**PRD v2.2** · BTC/USDT 5m · Martingale 4-loss stop · CLOB V2

Polymarket BTC 5 分钟涨跌盘口自动交易机器人。每 5 分钟根据 K 线反转信号，在**当前刚开盘的盘口**下单，马丁格尔管理仓位，K 线方向判定输赢。

## 策略

基于**两根已收盘**的 5m K 线（`K[-2]` 上上根、`K[-1]` 上一根）：

| 条件 | 信号 | 操作 |
|------|------|------|
| 上上根阳 + 上一根阴 | **S1** DOWN | 买跌（NO token） |
| 上上根阴 + 上一根阳 | **S2** UP | 买涨（YES token） |
| 同向 / 十字线 | NONE | 跳过 |

- 信号产生后，交易**当前刚开盘**的 5m 盘口（`btc-updown-5m-{windowStartUnix}`），不是下一个周期。
- 输赢判定：下注窗口那根 5m K 线收盘后，`close >= open` 为 UP 赢，否则 DOWN 赢（与 Polymarket 规则一致）。
- 结算在每个新周期**开始时同步完成**，更新马丁后再计算本周期下注金额。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env（见下方「关键环境变量」）

# 3. 生成 API 凭证（需先配置私钥）
npm run create-api-key

# 4. 检查配置
node scripts/check-env.js

# 5. 空跑测试（不提交真实订单）
npm run dry

# 6. 正式运行
npm start
```

## 服务器部署

详见 **[DEPLOY.md](./DEPLOY.md)**（PM2 / systemd、`.env`、加密私钥、`OHLCV_EXCHANGE=okx`）。

### 多账号（同一台服务器）

每个账号独立文件夹 + 独立 `.env` + 独立 PM2 进程名，互不影响：

```bash
git clone <仓库> ~/PMfanz2
cd ~/PMfanz2 && npm install
cp .env.example .env   # 填入账号 2 的密钥与参数
npm run encrypt-key    # 或明文 POLY_PRIVATE_KEY（仅本地）
npm run create-api-key
pm2 start src/index.js --name pmfanz2 --time
pm2 save
```

> 不要用 `ecosystem.config.cjs` 跑第二个号（进程名写死为 `polymarket-bot` 会冲突）。直接用 `--name` 指定唯一名称。

## 项目结构

```
src/
├── index.js                         # 调度入口（UTC 5m 边界 + 同步结算 + TG 推送）
├── config.js                        # 读取 .env + 默认值
├── collector/binance.js             # CCXT 拉取 OHLCV（okx/binance/bybit，自动 fallback）
├── strategy/reversalContinuation.js # 信号纯函数 S1/S2
├── market/polymarket.js             # Gamma 市场发现（当前 5m 盘口）
├── trader/executor.js               # CLOB V2 下单、余额、deposit wallet 自动检测
├── martingale/manager.js            # 马丁格尔状态机 + 持久化
└── utils/
    ├── logger.js                    # Winston 日志
    ├── retry.js                     # 指数退避重试
    ├── secrets.js                   # 私钥 AES-256-GCM 加解密
    └── telegram.js                  # Telegram 开单通知
scripts/
├── encrypt-key.js                   # 私钥加密（npm run encrypt-key）
├── create-api-key.js                # 生成 Polymarket API 凭证
├── check-env.js                     # 检查 .env 配置
├── test-cycle.js                    # 单次空跑周期测试
├── test-telegram.js                 # Telegram 连通性测试
└── diagnose-order.js                # 强制下单诊断（调试用）
logs/
├── signals.jsonl                    # 每轮信号（含 NONE）
├── trades.jsonl                     # 每笔下单记录
├── martingale-state.json            # 马丁格尔持久化状态
└── pending-bet.json                 # 待结算注单（重启后恢复）
```

## 关键环境变量

完整列表见 [.env.example](./.env.example)。

### Polymarket / 钱包

| 变量 | 默认 | 说明 |
|------|------|------|
| `POLY_ADDRESS` | — | 钱包地址 |
| `POLY_PRIVATE_KEY` | — | 明文私钥（仅本地开发） |
| `POLY_PRIVATE_KEY_ENCRYPTED` | — | 加密私钥（服务器推荐） |
| `POLY_KEY_PASSWORD` | — | 解密密码（与加密私钥配对） |
| `POLY_FUNDER_ADDRESS` | 自动 | 资金钱包；留空则自动推导 deposit wallet |
| `POLY_API_KEY` / `POLY_API_SECRET` / `POLY_PASSPHRASE` | — | CLOB API 凭证（`npm run create-api-key` 生成） |

新账户使用 Polymarket **Deposit Wallet**，Bot 会自动探测 `POLY_1271` 等签名类型并读取 pUSD 余额。

### 数据源 / 策略

| 变量 | 默认 | 说明 |
|------|------|------|
| `OHLCV_EXCHANGE` | okx | K 线主交易所（国内建议 okx；失败自动 fallback） |
| `TRADING_SYMBOL` | BTC/USDT | 交易对 |
| `CANDLE_TIMEFRAME` | 5m | K 线周期 |
| `SIGNAL_DELAY_MS` | 10000 | K 线收盘后等待毫秒数再拉数据 |

### 下单 / 风控

| 变量 | 默认 | 说明 |
|------|------|------|
| `TRADE_BUDGET_USD` | 1 | 马丁基础注（首注金额） |
| `MARTINGALE_MULTIPLIER` | 2 | 连亏翻倍倍数 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏几次后止损重置 |
| `MAX_BET_USD` | 200 | 单笔硬上限 |
| `MAX_DAILY_LOSS_USD` | 50 | 每日亏损上限 |
| `MIN_BALANCE_USD` | 20 | 余额低于此值跳过下单 |
| `ORDER_TYPE` | FOK | 订单类型（Fill-Or-Kill 市价单） |
| `ORDER_FILL_ATTEMPTS` | 4 | 未成交重试次数 |
| `ORDER_RETRY_DELAY_MS` | 8000 | 重试间隔（ms） |
| `DRY_RUN` | false | true = 模拟下单，不提交真实订单 |
| `SKIP_IF_YES_PRICE_OUT_OF_RANGE` | true | YES 价格超出范围时跳过 |
| `YES_PRICE_MIN` / `YES_PRICE_MAX` | 0.05 / 0.95 | 可接受价格区间 |

### Telegram

| 变量 | 默认 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | — | Bot Token（留空则不推送） |
| `TELEGRAM_CHAT_ID` | — | 接收消息的 Chat ID |

> `.env` 中**不要重复定义同名变量**（后面的空值会覆盖前面的有效值）。填完可用 `grep -i telegram .env` 确认每个变量只出现一次。

## 马丁格尔说明

以 `TRADE_BUDGET_USD=4`、`MARTINGALE_MULTIPLIER=2` 为例：

| 连亏轮次 | 下注金额 |
|----------|----------|
| 0（重置后） | $4 |
| 1 | $8 |
| 2 | $16 |
| 3 | $32 |
| 4（止损） | 跳过下一笔，再回 $4 |

单轮最大理论亏损：$4 + $8 + $16 + $32 = **$60**。请确保 `MAX_DAILY_LOSS_USD` 和账户余额 ≥ 整条马丁阶梯所需资金。

实际下注 = `min(currentBet, MAX_BET_USD, 可用余额)`。

## 常用脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 正式运行 |
| `npm run dry` | 空跑（`DRY_RUN=true`） |
| `npm run encrypt-key` | 加密私钥 |
| `npm run create-api-key` | 生成 API Key / Secret / Passphrase |
| `node scripts/check-env.js` | 检查配置完整性 |
| `node scripts/test-telegram.js` | 测试 Telegram 推送 |
| `DRY_RUN=true node scripts/test-cycle.js` | 单次周期空跑 |
| `node scripts/diagnose-order.js` | 诊断下单（强制在当前盘口试单） |

## 私钥加密（服务器推荐）

**不要把明文私钥放在服务器 `.env` 里。**

```bash
# 1. 本地或服务器加密
npm run encrypt-key
# 或: node scripts/encrypt-key.js --key 0x... --password '你的密码'

# 2. 将输出的 POLY_PRIVATE_KEY_ENCRYPTED 写入 .env
# 3. 设置 POLY_KEY_PASSWORD（可写在 .env 或 export，勿提交 git）
# 4. 删除或注释 POLY_PRIVATE_KEY 行
```

- 算法：AES-256-GCM + scrypt 派生密钥
- `POLY_KEY_PASSWORD` 丢失则无法解密，请妥善备份

## PM2 常用命令

```bash
pm2 start src/index.js --name polymarket-bot --time   # 单账号
pm2 logs polymarket-bot --lines 100 --nostream        # 查看最近 100 行
pm2 restart polymarket-bot
pm2 list
pm2 save
```

## 注意事项

- 运行前确认 Polymarket 钱包 deposit wallet 中有足够 **pUSD**（≥ `MIN_BALANCE_USD`）
- 国内服务器请设 `OHLCV_EXCHANGE=okx`
- 新盘口刚开盘时 Polymarket 可能返回 `425 service not ready` 或流动性不足；Bot 会自动重试，仍失败则跳过该信号（马丁不受影响）
- 连续同向 K 线不会产生反转信号，属于正常行为
- 首次部署建议 `DRY_RUN=true` 空跑确认无报错后再切实盘
