// Шифрование бэкапов: AES-256-GCM. Формат файла: «ALSB» + версия (1 байт) + IV (12) + шифртекст + тег (16).
// Ключ — BACKUP_ENCRYPTION_KEY (32 байта: 64 hex-символа или base64). Без ключа бэкап не прочитать —
// храните его отдельно от Render (например, в менеджере паролей).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const MAGIC = Buffer.from('ALSB');
const VERSION = 1;
const HEADER = MAGIC.length + 1 + 12;
const TAG = 16;

export function parseKey(value) {
  const text = String(value ?? '').trim();
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  else if (text) {
    try {
      key = Buffer.from(text, 'base64');
    } catch {
      key = null;
    }
  }
  if (!key || key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY: нужен ключ 32 байта (64 hex-символа или base64).');
  return key;
}

/** Зашифровать поток source в файл target. */
export async function encryptToFile(source, target, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(target);
  out.write(Buffer.concat([MAGIC, Buffer.from([VERSION]), iv]));
  await pipeline(source, cipher, out, { end: false });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve())));
}

/**
 * Поток расшифрованных данных из файла. Подлинность (тег GCM) проверяется в конце потока:
 * при подмене или повреждении поток завершится ошибкой, поэтому восстановление идёт в транзакции.
 */
export async function decryptFileStream(file, key) {
  const { size } = await fs.stat(file);
  if (size < HEADER + TAG) throw new Error('Файл бэкапа повреждён: слишком короткий.');
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(HEADER);
    await handle.read(head, 0, HEADER, 0);
    if (!head.subarray(0, 4).equals(MAGIC) || head[4] !== VERSION) throw new Error('Это не файл бэкапа Luminous.');
    const tag = Buffer.alloc(TAG);
    await handle.read(tag, 0, TAG, size - TAG);
    const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(5, HEADER));
    decipher.setAuthTag(tag);
    const body = createReadStream(file, { start: HEADER, end: size - TAG - 1 });
    body.on('error', (error) => decipher.destroy(error));
    return body.pipe(decipher);
  } finally {
    await handle.close();
  }
}

/** Счётчик байтов в конвейере (для отчёта о размере). */
export function byteCounter() {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, get bytes() { return bytes; } };
}
