// Cookie посетителя и сессии. На HTTPS — префикс __Host- (только Secure, путь /, без Domain):
// такую cookie не может подложить поддомен или страница по HTTP.
import { parse } from 'cookie';

export function cookieNames(config) {
  const prefix = config.cookieSecure ? '__Host-' : '';
  return { visitor: `${prefix}vid`, session: `${prefix}sid` };
}

export function cookieOptions(config, maxAgeMs) {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}

export function readCookies(header) {
  try {
    return parse(String(header || ''));
  } catch {
    return {};
  }
}
