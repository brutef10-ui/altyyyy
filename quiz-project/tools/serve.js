#!/usr/bin/env node
// Мини-сервер статики без зависимостей: node tools/serve.js <папка> [порт]
//
// Примеры:
//   node tools/serve.js host-site 5500
//   node tools/serve.js player-site 5501
//
// Если задана переменная окружения SERVER_URL, она подставляется в js/config.js сайта
// (удобно для деплоя сайтов как отдельных сервисов на Railway/Render без правки файлов).
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [, , folder, portArg] = process.argv;
if (!folder) {
  console.error('Использование: node tools/serve.js <папка-сайта> [порт]');
  process.exit(1);
}

const root = path.resolve(folder);
const port = Number(process.env.PORT || portArg || 5500);
const serverUrl = (process.env.SERVER_URL || '').trim().replace(/\/+$/, '');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(root, decoded));
  if (target !== root && !target.startsWith(root + path.sep)) return null; // защита от ../
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory() ? path.join(target, 'index.html') : target;
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let file;
  try {
    file = await resolveFile(req.url);
  } catch {
    file = null;
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
    return;
  }

  try {
    let body = await fs.readFile(file);
    if (serverUrl && file.endsWith(`${path.sep}js${path.sep}config.js`)) {
      body = Buffer.from(body.toString('utf8').replace("const PRODUCTION_SERVER_URL = '';", `const PRODUCTION_SERVER_URL = ${JSON.stringify(serverUrl)};`));
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Не найдено');
  }
});

server.listen(port, () => {
  console.log(`${path.basename(root)}: http://localhost:${port}${serverUrl ? ` (сервер игры: ${serverUrl})` : ''}`);
});
