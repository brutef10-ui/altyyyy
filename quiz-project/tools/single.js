#!/usr/bin/env node
// Запуск одним процессом: сервер сам отдаёт оба сайта (SERVE_SITES=true).
// Удобно на телефоне (Termux) и на хостинге с одним сервисом.
//   Сайт ведущего: http://localhost:3000/host/
//   Сайт игрока:   http://localhost:3000/
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

const child = spawn(process.execPath, ['server.js'], {
  cwd: serverDir,
  env: { ...process.env, SERVE_SITES: 'true' },
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
