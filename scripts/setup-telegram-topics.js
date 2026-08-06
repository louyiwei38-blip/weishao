#!/usr/bin/env node
/**
 * Create Telegram forum topics for each bot instance and save thread IDs to .env.
 *
 * Prerequisites:
 * 1) Create a Telegram GROUP, enable Topics (Forum)
 * 2) Bot is admin with "Manage topics"
 * 3) .env has TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *
 * Usage:
 *   node scripts/setup-telegram-topics.js              # create + write .env (default)
 *   node scripts/setup-telegram-topics.js --dry
 *   node scripts/setup-telegram-topics.js --check       # only verify is_forum
 *   node scripts/setup-telegram-topics.js --status      # which TELEGRAM_THREAD_* missing
 *   node scripts/setup-telegram-topics.js --no-write-env
 *
 * If topics already exist but .env has no IDs: do NOT re-run create (duplicates).
 * Open each topic → Copy link → last number is thread id, e.g.
 *   https://t.me/c/1234567890/42  →  TELEGRAM_THREAD_BTC_5M=42
 */
import { existsSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const { buildInstances } = require('./lib/tradingUniverse.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const envPath = join(root, '.env');

if (existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const dry = process.argv.includes('--dry');
const checkOnly = process.argv.includes('--check');
const statusOnly = process.argv.includes('--status');
const noWrite = process.argv.includes('--no-write-env');
/** Default: write .env unless --no-write-env / --dry */
const writeEnv = !noWrite && !dry;

const INSTANCES = buildInstances(process.env);
console.log(
  'instances from .env:',
  INSTANCES.map((i) => i.id).join(', ') || '(none)',
);

function envKey(id) {
  return `TELEGRAM_THREAD_${id.replace(/-/g, '_').toUpperCase()}`;
}

function threadStatus() {
  const missing = [];
  const ok = [];
  for (const inst of INSTANCES) {
    const key = envKey(inst.id);
    const v = process.env[key];
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) ok.push({ id: inst.id, key, n });
    else missing.push({ id: inst.id, key, name: inst.name });
  }
  return { ok, missing };
}

async function api(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}

function printForumHelp() {
  console.error(`
[原因] 当前群还不是「论坛群」(is_forum=false)，Telegram 拒绝 createForumTopic。
脚本无法替你打开 Topics，必须在手机/电脑 Telegram 里手动开启：

  1. 打开群 → 点群名 → 编辑（铅笔）
  2. 打开「话题」/ Topics / 话题模式
  3. 保存后，群顶应出现话题列表（综合/General）
  4. 再确认 Bot 是管理员，且勾选「管理话题」

然后先检查：
  node scripts/setup-telegram-topics.js --check
看到 is_forum: true 后再：
  npm run setup:tg-topics
`);
}

function printRecoverHelp(missing) {
  console.log(`
[话题已在群里、但 .env 没有 ID]
不要再跑创建（会重复建话题）。请按下面补 ID：

  1. Telegram 打开某个话题（如 ETH 15m 九转）
  2. 话题名旁菜单 → Copy link / 复制链接
  3. 链接形如 https://t.me/c/xxxxxxxxxx/42
     最后的数字 42 就是 message_thread_id
  4. 写入 .env，例如：
`);
  for (const m of missing) {
    console.log(`     ${m.key}=<链接最后数字>   # ${m.name}`);
  }
  console.log(`
  5. 保存后：pm2 delete all && npm run pm2:start
  6. 验证：node scripts/setup-telegram-topics.js --status
     或：node scripts/test-telegram.js --instance=eth-15m
`);
}

if (statusOnly) {
  const { ok, missing } = threadStatus();
  console.log(`\nTelegram thread IDs in .env: ${ok.length} ok / ${missing.length} missing`);
  for (const r of ok) console.log(`  OK   ${r.key}=${r.n}`);
  for (const m of missing) console.log(`  MISS ${m.key}  (${m.name})`);
  if (missing.length) {
    printRecoverHelp(missing);
    process.exit(1);
  }
  console.log('\n[OK] 全部实例都有 TELEGRAM_THREAD_*，重启 PM2 后应推到对应话题。');
  process.exit(0);
}

if (!token || !chatId) {
  console.error('[FAIL] Need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

console.log('chatId:', chatId);
console.log('dry   :', dry);
console.log('write :', writeEnv);

const chatInfo = await api('getChat', { chat_id: chatId });
if (!chatInfo.ok) {
  console.error('[FAIL] getChat failed:', chatInfo.description || chatInfo);
  process.exit(1);
}

const chat = chatInfo.result || {};
console.log('title :', chat.title || '(none)');
console.log('type  :', chat.type || '(none)');
console.log('is_forum:', chat.is_forum === true);

if (checkOnly) {
  if (chat.is_forum === true) {
    console.log('\n[OK] 群已是论坛，可以创建话题。');
    process.exit(0);
  }
  printForumHelp();
  process.exit(1);
}

if (chat.is_forum !== true) {
  console.error('\n[FAIL] the chat is not a forum');
  printForumHelp();
  process.exit(1);
}

const before = threadStatus();
if (before.missing.length === INSTANCES.length && before.ok.length === 0) {
  console.log(
    '\n[提示] .env 里还没有任何 TELEGRAM_THREAD_*。若群里话题已建过，请先 --status 按链接补 ID；继续运行会再创建一套话题。\n',
  );
}

console.log('');

const lines = [
  '',
  '# Telegram forum topics (one group + Topics) — generated by setup-telegram-topics.js',
];
const created = [];

for (const inst of INSTANCES) {
  const key = envKey(inst.id);
  const existing = process.env[key];
  if (existing && Number(existing) > 0) {
    console.log(`[skip] ${inst.name} already has ${key}=${existing}`);
    lines.push(`${key}=${existing}`);
    continue;
  }

  if (dry) {
    console.log(`[dry] would create topic: ${inst.name} → ${key}`);
    continue;
  }

  const json = await api('createForumTopic', {
    chat_id: chatId,
    name: inst.name,
  });

  if (!json.ok) {
    console.error(`[FAIL] createForumTopic ${inst.name}:`, json.description || json);
    if (String(json.description || '').includes('not a forum')) printForumHelp();
    else console.error('  Hint: bot must be admin with manage topics.');
    process.exit(1);
  }

  const threadId = json.result?.message_thread_id;
  console.log(`[ok] ${inst.name} → ${key}=${threadId}`);
  lines.push(`${key}=${threadId}`);
  created.push(key);
  process.env[key] = String(threadId);

  await api('sendMessage', {
    chat_id: chatId,
    message_thread_id: threadId,
    text: `Topic ready for bot instance ${inst.id}`,
  });
}

const toWrite = lines.filter((l) => l.startsWith('TELEGRAM_'));
console.log('\n--- .env lines ---');
console.log(toWrite.join('\n') || '(none new)');

if (writeEnv && toWrite.length && !dry) {
  if (!existsSync(envPath)) {
    console.error(`[FAIL] no .env at ${envPath}`);
    process.exit(1);
  }
  const envText = readFileSync(envPath, 'utf8');
  const missingKeys = toWrite.filter((line) => {
    const k = line.split('=')[0];
    // only append keys not already present as assignment
    const re = new RegExp(`^\\s*${k}\\s*=`, 'm');
    return !re.test(envText);
  });
  if (missingKeys.length) {
    appendFileSync(envPath, `\n${lines[0]}\n${lines[1]}\n${missingKeys.join('\n')}\n`, 'utf8');
    console.log(`\n[ok] appended ${missingKeys.length} key(s) to ${envPath}`);
  } else {
    console.log(`\n[ok] .env already contains these TELEGRAM_THREAD_* keys`);
  }
} else if (!writeEnv) {
  console.log('\nTip: 默认会写入 .env；若刚才用了 --no-write-env，请手动粘贴上面的行。');
}

const after = threadStatus();
if (after.missing.length) {
  console.log(`\n[warn] 仍缺 ${after.missing.length} 个 thread id`);
  printRecoverHelp(after.missing);
} else {
  console.log('\n[OK] 全部 TELEGRAM_THREAD_* 已就绪');
}

console.log('\nThen: pm2 delete all && npm run pm2:start');
console.log('Verify: node scripts/setup-telegram-topics.js --status');
