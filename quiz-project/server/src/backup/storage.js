// Где хранить бэкапы: Google Drive (через OAuth-токен владельца, scope drive.file — приложение видит
// только свои файлы) или локальная папка (для проверки и ручных копий).
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class LocalDirStorage {
  constructor(dir) {
    this.dir = dir;
  }

  async upload(name, file) {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, name);
    await fs.copyFile(file, target);
    const { size } = await fs.stat(target);
    return { id: name, name, size };
  }

  async list() {
    try {
      const names = (await fs.readdir(this.dir)).filter((name) => name.endsWith('.alsb'));
      const items = await Promise.all(names.map(async (name) => ({ id: name, name, createdAt: (await fs.stat(path.join(this.dir, name))).mtime.toISOString() })));
      return items.sort((a, b) => b.name.localeCompare(a.name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async download(id, target) {
    await fs.copyFile(path.join(this.dir, path.basename(id)), target);
  }

  async remove(id) {
    await fs.rm(path.join(this.dir, path.basename(id)), { force: true });
  }
}

const GOOGLE = {
  token: 'https://oauth2.googleapis.com/token',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
};
const FOLDER_NAME = 'Luminous backups';
// Так папка называлась до переименования проекта: найденную старую папку переименовываем, копии остаются вместе.
const OLD_FOLDER_NAMES = ['AL Studio backups'];

export class GoogleDriveStorage {
  #token = null;
  #tokenExpires = 0;

  constructor({ clientId, clientSecret, refreshToken, folderId = '', endpoints = GOOGLE, fetchImpl = fetch }) {
    if (!clientId || !clientSecret || !refreshToken) throw new Error('Google Drive: нужны GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET и GOOGLE_DRIVE_REFRESH_TOKEN.');
    this.credentials = { clientId, clientSecret, refreshToken };
    this.folderId = folderId;
    this.endpoints = endpoints;
    this.fetch = fetchImpl;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpires - 60_000) return this.#token;
    const response = await this.fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        refresh_token: this.credentials.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error(`Google Drive: не удалось получить доступ (${data.error ?? response.status}). Проверьте токен.`);
    this.#token = data.access_token;
    this.#tokenExpires = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.#token;
  }

  async #request(url, options = {}) {
    const token = await this.#accessToken();
    const response = await this.fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Google Drive: ${response.status} ${text.slice(0, 200)}`);
    }
    return response;
  }

  async #folder() {
    if (this.folderId) return this.folderId;
    const names = [FOLDER_NAME, ...OLD_FOLDER_NAMES].map((name) => `name='${name}'`).join(' or ');
    const q = `mimeType='application/vnd.google-apps.folder' and (${names}) and trashed=false`;
    const found = (await (await this.#request(`${this.endpoints.api}/files?q=${encodeURIComponent(q)}&fields=files(id,name)`)).json()).files ?? [];
    const folder = found.find((item) => item.name === FOLDER_NAME) ?? found[0];
    if (folder) {
      this.folderId = folder.id;
      if (folder.name !== FOLDER_NAME) {
        await this.#request(`${this.endpoints.api}/files/${folder.id}?fields=id`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: FOLDER_NAME }),
        }).catch(() => {}); // не удалось переименовать — не страшно, копии продолжат ложиться в старую папку
      }
    } else {
      const created = await (await this.#request(`${this.endpoints.api}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      })).json();
      this.folderId = created.id;
    }
    return this.folderId;
  }

  async upload(name, file) {
    const folder = await this.#folder();
    const { size } = await fs.stat(file);
    // Возобновляемая загрузка: сначала создаём сессию, затем отправляем файл одним запросом.
    const session = await this.#request(`${this.endpoints.upload}/files?uploadType=resumable&fields=id,name,size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(size) },
      body: JSON.stringify({ name, parents: [folder] }),
    });
    const location = session.headers.get('location');
    if (!location) throw new Error('Google Drive: не получен адрес загрузки.');
    const response = await this.fetch(location, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: createReadStream(file),
      duplex: 'half',
    });
    if (!response.ok) throw new Error(`Google Drive: загрузка не удалась (${response.status}).`);
    const data = await response.json();
    return { id: data.id, name: data.name, size: Number(data.size ?? size) };
  }

  async list() {
    const folder = await this.#folder();
    const q = `'${folder}' in parents and trashed=false`;
    const data = await (await this.#request(`${this.endpoints.api}/files?q=${encodeURIComponent(q)}&orderBy=createdTime desc&pageSize=200&fields=files(id,name,size,createdTime)`)).json();
    return (data.files ?? []).filter((item) => item.name.endsWith('.alsb')).map((item) => ({ id: item.id, name: item.name, size: Number(item.size ?? 0), createdAt: item.createdTime }));
  }

  async download(id, target) {
    const response = await this.#request(`${this.endpoints.api}/files/${encodeURIComponent(id)}?alt=media`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  }

  async remove(id) {
    await this.#request(`${this.endpoints.api}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

/** Хранилище по настройкам: Google Drive, если заданы его переменные, иначе папка BACKUP_DIR, иначе null. */
export function storageFromConfig(config) {
  const drive = config.backup.googleDrive;
  if (drive.clientId && drive.clientSecret && drive.refreshToken) return new GoogleDriveStorage(drive);
  if (config.backup.dir) return new LocalDirStorage(config.backup.dir);
  return null;
}
