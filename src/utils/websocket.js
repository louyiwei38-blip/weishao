/**
 * Unified WebSocket: native (Node 20+) or ws package (Node 18 / PM2).
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function resolveWebSocket() {
  if (typeof globalThis.WebSocket !== 'undefined') {
    return { WebSocket: globalThis.WebSocket, flavor: 'native' };
  }
  try {
    const Ws = require('ws');
    return { WebSocket: Ws, flavor: 'ws' };
  } catch {
    return null;
  }
}

export function bindSocket(socket, flavor, handlers) {
  if (flavor === 'native') {
    socket.addEventListener('open', handlers.onOpen);
    socket.addEventListener('message', handlers.onMessage);
    socket.addEventListener('close', handlers.onClose);
    socket.addEventListener('error', handlers.onError);
    return;
  }

  socket.on('open', handlers.onOpen);
  socket.on('message', (data) => {
    const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    handlers.onMessage({ data: raw });
  });
  socket.on('close', handlers.onClose);
  socket.on('error', handlers.onError);
}

export function sendSocket(socket, _flavor, payload) {
  socket.send(payload);
}
