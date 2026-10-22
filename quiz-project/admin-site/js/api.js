// Запросы админ-консоли. Права проверяет сервер (роль из сессии в БД) на каждом запросе.
let csrfToken = null;

export class AdminError extends Error {
  constructor(message, { status = 0, code = null, details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function session() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  csrfToken = data.csrfToken;
  return data;
}

async function call(path, { method = 'GET', body } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    if (!csrfToken) await session();
    headers['X-CSRF-Token'] = csrfToken ?? '';
  }
  let response;
  try {
    response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new AdminError('Сервер недоступен. Проверьте соединение.');
  }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (response.status === 401) {
    location.href = `/host/login.html?next=${encodeURIComponent('/admin/')}`;
    throw new AdminError('Войдите заново', { status: 401, code: 'UNAUTHORIZED' });
  }
  if (response.status === 403 && data?.code === 'CSRF' && !retried) {
    await session();
    return call(path, { method, body }, true);
  }
  if (!response.ok) throw new AdminError(data?.error || `Ошибка сервера (${response.status})`, { status: response.status, code: data?.code, details: data?.details });
  return data;
}

const query = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null && value !== '') search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : '';
};

export const adminApi = {
  session,
  overview: () => call('/api/admin/overview'),
  accounts: (params) => call(`/api/admin/accounts${query(params)}`),
  visitors: (params) => call(`/api/admin/visitors${query(params)}`),
  account: (id) => call(`/api/admin/accounts/${encodeURIComponent(id)}`),
  visitor: (id) => call(`/api/admin/visitors/${encodeURIComponent(id)}`),
  events: (params) => call(`/api/admin/events${query(params)}`),
  audit: (params) => call(`/api/admin/audit${query(params)}`),
  bans: (params) => call(`/api/admin/bans${query(params)}`),
  createBan: (body) => call('/api/admin/bans', { method: 'POST', body }),
  liftBan: (id, reason) => call(`/api/admin/bans/${encodeURIComponent(id)}/lift`, { method: 'POST', body: { reason } }),
  issueCode: (accountId) => call(`/api/admin/accounts/${encodeURIComponent(accountId)}/recovery-code`, { method: 'POST' }),
  logout: () => call('/api/auth/logout', { method: 'POST' }),
  settings: () => call('/api/admin/settings'),
  runBackup: () => call('/api/admin/backup/run', { method: 'POST' }),
  devices: () => call('/api/admin/devices'),
  removeDevice: (id) => call(`/api/admin/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setSharing: (enabled) => call('/api/admin/settings/sharing', { method: 'POST', body: { enabled } }),
  recomputeSharing: () => call('/api/admin/sharing/recompute', { method: 'POST' }),
  setSharingHidden: (id, hidden) => call(`/api/admin/accounts/${encodeURIComponent(id)}/sharing-hidden`, { method: 'POST', body: { hidden } }),
};
