#!/usr/bin/env node
// Запускает всё сразу для локальной разработки: сервер (3000), сайт ведущего (5500), сайт игрока (5501).
// Перед первым запуском: npm install --prefix server
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const processes = [
  { name: 'server', color: 35, args: ['server.js'], cwd: path.join(root, 'server') },
  { name: 'host  ', color: 33, args: ['tools/serve.js', 'host-site', '5500'], cwd: root },
  { name: 'player', color: 36, args: ['tools/serve.js', 'player-site', '5501'], cwd: root },
];

const children = processes.map(({ name, color, args, cwd }) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, PORT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const print = (stream) => (chunk) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) stream.write(prefix + line + '\n');
  };
  child.stdout.on('data', print(process.stdout));
  child.stderr.on('data', print(process.stderr));
  child.on('exit', (code) => {
    if (code) console.error(`${prefix}завершился с кодом ${code}`);
  });
  return child;
});

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
