/**
 * Inline keyboard + callback_data for Telegram control buttons.
 */
import config from '../config.js';

const VALIDITY_MS = () => config.telegram.buttonValidityMs;

/** @typedef {'reset'} ButtonAction */

function encodeInstanceId(instanceId) {
  return String(instanceId || '').replace(/-/g, '');
}

export function buildCallbackData(action, instanceId = config.instanceId, expMs = Date.now() + VALIDITY_MS()) {
  const inst = encodeInstanceId(instanceId);
  const exp = Math.trunc(expMs / 1000);
  if (action !== 'reset') return '';
  return `v1:r:${inst}:${exp}`;
}

export function parseCallbackData(data) {
  const parts = String(data || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { ok: false, reason: 'bad_format' };
  }
  const code = parts[1];
  const instRaw = parts[2];
  const exp = Number(parts[3]);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'bad_exp' };
  if (Date.now() > exp * 1000) return { ok: false, reason: 'expired', exp };

  /** @type {ButtonAction|null} */
  let action = null;
  if (code === 'r') action = 'reset';
  else return { ok: false, reason: 'bad_action' };

  return { ok: true, action, instanceId: decodeInstanceId(instRaw), exp };
}

function decodeInstanceId(compact) {
  const s = String(compact || '');
  const m = s.match(/^([a-z]+)(\d+m|\d+h)$/i);
  if (m) return `${m[1]}-${m[2].toLowerCase()}`;
  return s;
}

export function buildInlineKeyboard(instanceId = config.instanceId) {
  const exp = Date.now() + VALIDITY_MS();
  const resetInst = config.telegram.resetInstanceId;
  return {
    inline_keyboard: [
      [{ text: '🔄 重置本金/净胜负', callback_data: buildCallbackData('reset', resetInst, exp) }],
    ],
  };
}
