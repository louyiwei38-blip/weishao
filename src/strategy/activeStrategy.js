/**
 * Active strategy facade — vegas channel OR 神奇九转.
 * Selected by config.strategy (STRATEGY env).
 */
import config from '../config.js';
import * as vegasState from './vegasState.js';
import * as jzState from './jzState.js';
import { MIN_SIGNAL_CANDLES as VEGAS_MIN } from './vegasChannel.js';
import { MIN_SIGNAL_CANDLES as JZ_MIN } from './magicNineTurns.js';

export const isJz = () => config.strategy === 'jz';

export function strategyKey() {
  return isJz() ? 'jz' : 'vegas';
}

export function strategyLabel() {
  return isJz() ? '神奇九转' : '维加斯通道';
}

export function strategyShortTag() {
  return isJz() ? '九转' : '维加斯';
}

export function strategyLogId() {
  return isJz() ? 'magic_nine_turns' : 'vegas_channel_okx_ema144_169';
}

export const MIN_SIGNAL_CANDLES = isJz() ? JZ_MIN : VEGAS_MIN;

function api() {
  return isJz() ? jzState : vegasState;
}

export function init() {
  return api().init();
}

export function getState() {
  return api().getState();
}

export function resolveSignal(candles) {
  return api().resolveSignal(candles);
}

export function onSettled(won, halted) {
  return api().onSettled(won, halted);
}

export function abortEntryLock(reason) {
  return api().abortEntryLock(reason);
}
