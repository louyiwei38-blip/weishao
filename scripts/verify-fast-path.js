#!/usr/bin/env node
/**
 * Verify fast-path gating + signal-data retry helpers (no network / no live orders).
 * Usage: node scripts/verify-fast-path.js
 */

import assert from 'node:assert/strict';
import {
  shouldMgContFastPath,
  nextCycleStartTs,
  isWithinTradeWindow,
  resolveCycleSignalDelayMs,
  defaultSignalDelayMs,
} from '../src/utils/fastPath.js';
import {
  isSignalDataNotReady,
  resolveSignalDataDeadlineMs,
} from '../src/utils/signalData.js';
import config from '../src/config.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('=== verify-fast-path ===\n');

console.log('[1] shouldMgContFastPath');
check('loss + in_chain + UP → true', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: false,
      halted: false,
      phase: 'in_chain',
      lockedSignal: 'UP',
    }),
    true,
  );
});
check('win → false', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: true,
      halted: false,
      phase: 'in_chain',
      lockedSignal: 'UP',
    }),
    false,
  );
});
check('halted (5 losses) → false', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: false,
      halted: true,
      phase: 'need_outside',
      lockedSignal: null,
    }),
    false,
  );
});
check('need_outside → false (no false continuation)', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: false,
      halted: false,
      phase: 'need_outside',
      lockedSignal: null,
    }),
    false,
  );
});
check('armed → false', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: false,
      halted: false,
      phase: 'armed',
      lockedSignal: null,
    }),
    false,
  );
});
check('disabled flag → false', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: false,
      won: false,
      halted: false,
      phase: 'in_chain',
      lockedSignal: 'DOWN',
    }),
    false,
  );
});
check('invalid lockedSignal → false', () => {
  assert.equal(
    shouldMgContFastPath({
      enabled: true,
      won: false,
      halted: false,
      phase: 'in_chain',
      lockedSignal: 'NONE',
    }),
    false,
  );
});

console.log('\n[2] timing helpers');
check('nextCycleStartTs', () => {
  assert.equal(nextCycleStartTs(1_000_000, 300_000), 1_300_000);
});
check('isWithinTradeWindow early in cycle', () => {
  const start = 1_000_000;
  const cycleMs = 300_000;
  assert.equal(isWithinTradeWindow(start + 5_000, start, cycleMs, 15_000), true);
});
check('isWithinTradeWindow too late', () => {
  const start = 1_000_000;
  const cycleMs = 300_000;
  assert.equal(isWithinTradeWindow(start + cycleMs - 10_000, start, cycleMs, 15_000), false);
});
check('isWithinTradeWindow before open', () => {
  assert.equal(isWithinTradeWindow(999_000, 1_000_000, 300_000, 15_000), false);
});

console.log('\n[3] resolveCycleSignalDelayMs');
check('new signal uses full delay', () => {
  assert.equal(
    resolveCycleSignalDelayMs({
      phase: 'armed',
      lockedSignal: null,
      hasPending: false,
      signalDelayMs: 5000,
      inChainSignalDelayMs: 300,
      settleBufferMs: 1500,
    }),
    5000,
  );
});
check('in_chain uses short delay', () => {
  assert.equal(
    resolveCycleSignalDelayMs({
      phase: 'in_chain',
      lockedSignal: 'UP',
      hasPending: false,
      signalDelayMs: 5000,
      inChainSignalDelayMs: 300,
      settleBufferMs: 1500,
    }),
    300,
  );
});
check('pending waits at least settle buffer', () => {
  assert.equal(
    resolveCycleSignalDelayMs({
      phase: 'in_chain',
      lockedSignal: 'UP',
      hasPending: true,
      signalDelayMs: 1000,
      inChainSignalDelayMs: 300,
      settleBufferMs: 1500,
    }),
    1700,
  );
});

console.log('\n[4] defaultSignalDelayMs');
check('5m → 3000', () => assert.equal(defaultSignalDelayMs('5m'), 3000));
check('15m → 4000', () => assert.equal(defaultSignalDelayMs('15m'), 4000));
check('1h → 5000', () => assert.equal(defaultSignalDelayMs('1h'), 5000));

console.log('\n[5] live config defaults (may be overridden by .env)');
check('mgContFastPath enabled by default or env', () => {
  assert.equal(typeof config.mgContFastPath, 'boolean');
});
check('orderRetryDelayMs is finite', () => {
  assert.ok(Number.isFinite(config.orderRetryDelayMs));
  assert.ok(config.orderRetryDelayMs > 0);
});
check('signalDelayMs is finite and > 0 (freshness gate kept)', () => {
  assert.ok(Number.isFinite(config.signalDelayMs));
  assert.ok(config.signalDelayMs > 0, 'SIGNAL_DELAY must stay > 0 to avoid unclosed candle signals');
});
check('inChainSignalDelayMs <= signalDelayMs', () => {
  assert.ok(config.inChainSignalDelayMs <= config.signalDelayMs);
});
check('settleBufferMs is finite', () => {
  assert.ok(Number.isFinite(config.chainlink.settleBufferMs));
});
check('prewarmMs is finite', () => {
  assert.ok(Number.isFinite(config.prewarmMs));
});
check('martingaleMaxLosses >= 1', () => {
  assert.ok(config.martingaleMaxLosses >= 1);
});

console.log('\n[6] signal data readiness (in-cycle retry)');
check('EMA 未对齐 → retryable', () => {
  assert.equal(isSignalDataNotReady('OKX EMA 未对齐到当前 K 线', true), true);
});
check('拉取失败 → retryable by reason', () => {
  assert.equal(isSignalDataNotReady('OKX EMA 拉取失败: timeout'), true);
});
check('真实无穿越 → not retryable', () => {
  assert.equal(
    isSignalDataNotReady('无穿越入场（上一根实体在上方，本根影线未入通道）', false),
    false,
  );
});
check('等待通道外 → not retryable', () => {
  assert.equal(
    isSignalDataNotReady('等待至少一根 K 线实体完全在维加斯通道外', false),
    false,
  );
});
check('deadline respects maxWait', () => {
  const now = 1_000_000;
  const start = 1_000_000;
  const cycleMs = 300_000;
  const d = resolveSignalDataDeadlineMs({
    nowMs: now,
    cycleStartTs: start,
    cycleMs,
    maxWaitMs: 60_000,
    minTradeRemainingMs: 15_000,
  });
  assert.equal(d, now + 60_000);
});
check('deadline respects trade remaining window', () => {
  const start = 1_000_000;
  const cycleMs = 300_000;
  const late = resolveSignalDataDeadlineMs({
    nowMs: start + cycleMs - 20_000,
    cycleStartTs: start,
    cycleMs,
    maxWaitMs: 60_000,
    minTradeRemainingMs: 15_000,
  });
  assert.equal(late, start + cycleMs - 15_000);
});
check('config signalDataRetryMs', () => {
  assert.ok(Number.isFinite(config.signalDataRetryMs));
  assert.ok(config.signalDataRetryMs > 0);
});
check('config signalDataMaxWaitMs', () => {
  assert.ok(Number.isFinite(config.signalDataMaxWaitMs));
  assert.ok(config.signalDataMaxWaitMs >= config.signalDataRetryMs);
});

console.log(`\n=== ${passed} checks passed ===`);
if (process.exitCode) {
  console.error('Verification FAILED');
  process.exit(1);
}
console.log('Verification OK');