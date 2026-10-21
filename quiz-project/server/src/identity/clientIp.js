// IP клиента за прокси. Одна функция для Express и Socket.IO.
//
// Перед сервисом на Render стоят прокси, которые ДОПИСЫВАЮТ адрес в конец X-Forwarded-For.
// Первое значение заголовка присылает сам клиент, и его можно подделать, поэтому берём адрес,
// который записал последний доверенный прокси: hops-й справа (hops = число прокси перед сервером).
// Режим header — взять адрес из заголовка, который доверенный прокси всегда перезаписывает сам.
// Как подобрать значение на реальном деплое — docs/ACCOUNTS_PLAN.md, раздел 4.
import { isIP } from 'node:net';

function normalize(address) {
  if (typeof address !== 'string') return null;
  let value = address.trim();
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) ? value.toLowerCase() : null;
}

export function forwardedChain(headers) {
  const raw = headers?.['x-forwarded-for'];
  return String(Array.isArray(raw) ? raw.join(',') : raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * @param {{ remoteAddress?: string, headers?: object }} source
 * @param {{ clientIpMode: 'hops'|'header', clientIpHeader: string, trustProxyHops: number }} config
 */
export function clientIp({ remoteAddress, headers = {} }, config) {
  if (config.clientIpMode === 'header' && config.clientIpHeader) {
    const value = normalize(String(headers[config.clientIpHeader] || '').split(',')[0]);
    if (value) return value;
  }
  const chain = [remoteAddress, ...forwardedChain(headers).reverse()];
  const hops = Math.max(0, config.trustProxyHops || 0);
  return normalize(chain[Math.min(hops, chain.length - 1)]) ?? normalize(remoteAddress);
}

export const ipFromRequest = (req, config) => clientIp({ remoteAddress: req.socket?.remoteAddress, headers: req.headers }, config);

export const ipFromSocket = (socket, config) =>
  clientIp({ remoteAddress: socket.handshake.address, headers: socket.handshake.headers }, config);
