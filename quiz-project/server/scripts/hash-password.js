// Хэш пароля администратора для переменной ADMIN_PASSWORD_HASH.
//
//   npm run hash-password
//
// Пароль вводится скрытно (не попадает в историю команд и на экран). Скрипт печатает только хэш argon2id.
// Сам пароль нигде не сохраняется; в настройки Render вставляется хэш.
import readline from 'node:readline';
import argon2 from 'argon2';

function readHidden(prompt) {
  return new Promise((resolve) => {
    const input = process.stdin;
    if (!input.isTTY) {
      // Пароль из канала: echo -n 'пароль' | npm run hash-password --silent
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => { data += chunk; });
      input.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n' || char === '\u0004') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    };
    input.on('data', onData);
  });
}

readline.emitKeypressEvents(process.stdin);
const password = await readHidden('Пароль администратора: ');
if (password.length < 12) {
  console.error('Пароль администратора — не короче 12 символов.');
  process.exit(1);
}
if (process.stdin.isTTY) {
  const repeat = await readHidden('Ещё раз: ');
  if (repeat !== password) {
    console.error('Пароли не совпадают.');
    process.exit(1);
  }
}
const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
console.log('\nADMIN_PASSWORD_HASH (вставьте целиком в переменные окружения Render):\n');
console.log(hash);
