# Polymarket Reversal Continuation Bot

**PRD v2.2** · BTC/USDT 5m · Martingale 4-loss stop

## 策略

- 上根阳 + 当根阴 → 买 NO（预测下一根阴）**S1**
- 上根阴 + 当根阳 → 买 YES（预测下一根阳）**S2**
- 其他组合 / 十字线 → 不交易

## 服务器部署

详见 **[DEPLOY.md](./DEPLOY.md)**（PM2 / systemd、`.env`、加密私钥、`OHLCV_EXCHANGE=okx`）。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 POLY_PRIVATE_KEY / POLY_API_KEY / POLY_PASSPHRASE 等

# 3. 空跑测试（不提交真实订单）
DRY_RUN=true node src/index.js

# 4. 正式运行
node src/index.js
```

## 项目结构

```
src/
├── index.js                      # 调度入口（UTC 5m 边界触发）
├── config.js                     # 读取 .env + 默认值
├── collector/binance.js           # CCXT BTC/USDT 5m OHLCV
├── strategy/reversalContinuation.js  # 信号纯函数 S1/S2
├── market/polymarket.js           # Gamma 市场发现 + 结算轮询
├── trader/executor.js             # CLOB V2 下单 + 日志
├── martingale/manager.js          # 马丁格尔状态机 + 持久化
└── utils/
    ├── logger.js                  # Winston 日志
    └── retry.js                   # 指数退避重试
logs/
├── signals.jsonl                  # 每轮信号（含 NONE）
├── trades.jsonl                   # 每笔下单记录
└── martingale-state.json          # 马丁格尔持久化状态
```

## 关键环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `POLY_PRIVATE_KEY` | — | 钱包私钥 |
| `POLY_API_KEY` | — | Polymarket API Key |
| `POLY_PASSPHRASE` | — | API 密码短语 |
| `TRADE_BUDGET_USD` | 10 | 马丁基础注 |
| `MARTINGALE_MAX_LOSSES` | 4 | 连亏几次后止损重置 |
| `MAX_BET_USD` | 200 | 单笔硬上限 |
| `MAX_DAILY_LOSS_USD` | 50 | 每日亏损上限 |
| `DRY_RUN` | false | true = 不下真实订单 |
| `SIGNAL_DELAY_MS` | 10000 | K 收盘后等多久再拉数据（ms） |

## 马丁格尔说明

| 连亏轮次 | 下注金额 |
|----------|----------|
| 0（重置后） | $10 |
| 1 | $20 |
| 2 | $40 |
| 3 | $80 |
| 4（止损重置） | 跳过下一笔，再回 $10 |

单轮最大理论亏损：$10 + $20 + $40 + $80 = **$150**

## 服务器部署：私钥加密（推荐）

**不要把明文私钥放在服务器 `.env` 里。**

### 1. 在本地加密私钥

```bash
npm run encrypt-key
```

按提示输入私钥和强密码（≥8 位），会得到一行：

```
POLY_PRIVATE_KEY_ENCRYPTED=salt.iv.tag.data
```

### 2. 写入服务器 `.env`

```env
POLY_PRIVATE_KEY_ENCRYPTED=粘贴加密结果
# 删除 POLY_PRIVATE_KEY 这一行
POLY_ADDRESS=0x你的地址
POLY_API_KEY=...
POLY_PASSPHRASE=...
```

### 3. 解密密码只放在服务器环境变量（不要提交 git）

```bash
# Linux 启动前
export POLY_KEY_PASSWORD="你的强密码"
node src/index.js
```

或使用 systemd `Environment=POLY_KEY_PASSWORD=...`。

### 安全说明

- 算法：AES-256-GCM + scrypt 派生密钥
- `POLY_KEY_PASSWORD` 丢失则无法解密，请妥善备份密码
- `.env` 已在 `.gitignore` 中，切勿把 `.env` 推送到公开仓库

## 注意事项

- 运行前确认 Polygon 钱包有足够 pUSD（建议 ≥ $200）
- 首次运行若 pUSD 余额为 0，需手动通过 Polymarket Collateral Onramp 将 USDC.e 转换为 pUSD
- Polymarket BTC 5 分钟市场在非高峰期可能暂时缺口，Bot 会自动跳过并等待下一个周期
