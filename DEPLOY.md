# 服务器部署指南

## 一、服务器要求

| 项目 | 要求 |
|------|------|
| 系统 | Linux（Ubuntu 22.04+ 推荐）或 Windows Server |
| Node.js | **18+**（推荐 20 LTS） |
| 内存 | ≥ 512MB |
| 网络 | 能访问 `gamma-api.polymarket.com`、`clob.polymarket.com`、**OKX**（国内服务器勿依赖币安） |
| 钱包 | Polymarket 已充值 pUSD，建议 ≥ $30 |

---

## 二、上传项目到服务器

**不要上传** `node_modules/`、`.env`（在服务器单独创建）。

### 方式 A：压缩包

本地打包（排除依赖）后上传：

```powershell
# 本地 PowerShell（在项目目录）
Compress-Archive -Path src,scripts,package.json,package-lock.json,ecosystem.config.cjs,DEPLOY.md,README.md,PRD.md,.env.example -DestinationPath bot.zip
```

上传到服务器后：

```bash
unzip bot.zip -d ~/polymarket-bot
cd ~/polymarket-bot
```

### 方式 B：Git（推荐）

```bash
git clone <你的仓库> ~/polymarket-bot
cd ~/polymarket-bot
```

---

## 三、安装 Node.js（Linux）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # 应 >= v18
```

---

## 四、安装依赖

```bash
cd ~/polymarket-bot
npm install --production
```

---

## 五、配置 `.env`（服务器上新建）

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

### 必填项

```env
POLY_ADDRESS=0x你的地址
POLY_API_KEY=你的key
POLY_PASSPHRASE=你的passphrase
POLY_PRIVATE_KEY_ENCRYPTED=本地 encrypt-key 生成的密文

# 解密密码（仅服务器，不要提交 git）
POLY_KEY_PASSWORD=你加密私钥时设的密码

OHLCV_EXCHANGE=okx
TRADE_BUDGET_USD=1
MIN_BALANCE_USD=5
DRY_RUN=true
```

### 上线实盘时

```env
DRY_RUN=false
```

### 国内服务器注意

- **必须** `OHLCV_EXCHANGE=okx`（币安 `api.binance.com` 常被墙）
- 若 `MIN_BALANCE_USD=20` 而账户不足 $20，会一直跳过下单，小资金建议 `5`

---

## 六、先空跑验证

```bash
cd ~/polymarket-bot
export POLY_KEY_PASSWORD="你的解密密码"
DRY_RUN=true node src/index.js
```

看到 `━━━ cycle start` 且无 `OHLCV fetch failed` 即正常。`Ctrl+C` 停止。

或一键测试：

```bash
DRY_RUN=true node scripts/test-cycle.js
```

---

## 七、用 PM2 常驻运行（推荐）

```bash
sudo npm install -g pm2

cd ~/polymarket-bot
mkdir -p logs

# 空跑（确认稳定后再切实盘）
export POLY_KEY_PASSWORD="你的解密密码"
pm2 start ecosystem.config.cjs

# 查看日志
pm2 logs polymarket-bot

# 开机自启
pm2 save
pm2 startup
```

### 切换实盘

1. 编辑 `ecosystem.config.cjs`，在 `env` 中设置 `DRY_RUN: 'false'`，或：
2. 编辑 `.env` 中 `DRY_RUN=false`，然后：

```bash
export POLY_KEY_PASSWORD="你的解密密码"
pm2 restart polymarket-bot --update-env
```

或使用 `env_live` 配置：

```bash
export POLY_KEY_PASSWORD="你的解密密码"
pm2 start ecosystem.config.cjs --env live
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `pm2 status` | 进程状态 |
| `pm2 logs polymarket-bot` | 实时日志 |
| `pm2 restart polymarket-bot` | 重启 |
| `pm2 stop polymarket-bot` | 停止 |

---

## 八、不用 PM2：systemd（可选）

创建 `/etc/systemd/system/polymarket-bot.service`：

```ini
[Unit]
Description=Polymarket Reversal Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/polymarket-bot
Environment=POLY_KEY_PASSWORD=你的解密密码
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot
sudo journalctl -u polymarket-bot -f
```

---

## 九、日志与状态文件

| 路径 | 内容 |
|------|------|
| `logs/bot.log` | 主日志 |
| `logs/signals.jsonl` | 每轮信号 |
| `logs/trades.jsonl` | 下单记录 |
| `logs/martingale-state.json` | 马丁状态（重启后恢复） |

---

## 十、安全检查清单

- [ ] `.env` 权限 `chmod 600`
- [ ] `.env` 未提交到 Git
- [ ] `POLY_KEY_PASSWORD` 仅存在于服务器环境变量或受保护的 `.env`
- [ ] 先 `DRY_RUN=true` 跑至少 1 小时无报错
- [ ] 确认 Polymarket 钱包有足够 pUSD
- [ ] `OHLCV_EXCHANGE=okx`（国内服务器）

---

## 十一、常见问题

| 现象 | 处理 |
|------|------|
| `POLY_KEY_PASSWORD is missing` | `export POLY_KEY_PASSWORD=...` 后重启 |
| `OHLCV fetch failed` | 设 `OHLCV_EXCHANGE=okx` |
| `pUSD balance below minimum` | 充值或降低 `MIN_BALANCE_USD` |
| `no BTC 5M market found` | 等待下一 5 分钟周期，或检查网络到 Gamma API |
