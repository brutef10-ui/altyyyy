// Тип устройства, ОС и браузер из User-Agent (ua-parser-js 1.x, лицензия MIT).
// Результат — только для журнала и админ-консоли; ничего не решает в правах доступа.
import UAParser from 'ua-parser-js';

const MAX = 400;

export function parseUserAgent(userAgent) {
  const raw = typeof userAgent === 'string' ? userAgent.slice(0, MAX) : '';
  if (!raw) return { deviceType: null, os: null, browser: null };
  const { device, os, browser } = new UAParser(raw).getResult();
  // У компьютеров ua-parser не указывает тип устройства.
  const deviceType = device.type || (os.name ? 'desktop' : 'other');
  const join = (name, version) => (name ? [name, version].filter(Boolean).join(' ') : null);
  return {
    deviceType,
    os: join(os.name, os.version?.split('.').slice(0, 2).join('.')),
    browser: join(browser.name, browser.major),
  };
}
