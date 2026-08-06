/**
 * Active strategy — 神奇九转 only.
 * Multi-symbol × multi-TF processes share one bankroll (BANKROLL_SCOPE=jz).
 */
import * as jzState from './jzState.js';
import { MIN_SIGNAL_CANDLES as JZ_MIN } from './magicNineTurns.js';

export const isJz = () => true;

export function strategyKey() {
  return 'jz';
}

export function strategyLabel() {
  return '神奇九转';
}

export function strategyShortTag() {
  return '九转';
}

export function strategyLogId() {
  return 'magic_nine_turns';
}

export const MIN_SIGNAL_CANDLES = JZ_MIN;

export function init() {
  return jzState.init();
}

export function getState() {
  return jzState.getState();
}

export function resolveSignal(candles) {
  return jzState.resolveSignal(candles);
}

export function onSettled(won, halted) {
  return jzState.onSettled(won, halted);
}

export function abortEntryLock(reason) {
  return jzState.abortEntryLock(reason);
}
