// Получить GOOGLE_DRIVE_REFRESH_TOKEN для бэкапов (один раз, на своём компьютере):
//   GOOGLE_DRIVE_CLIENT_ID=… GOOGLE_DRIVE_CLIENT_SECRET=… npm run google-drive-auth
// Откроется ссылка Google: войдите в аккаунт, где будут храниться копии, и разрешите доступ.
// Доступ — только к файлам, которые создало само приложение (scope drive.file), не ко всему Диску.
// Полученный токен вставьте в Environment сервиса на Render (в репозиторий не коммитьте).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Задайте GOOGLE_DRIVE_CLIENT_ID и GOOGLE_DRIVE_CLIENT_SECRET (OAuth-клиент типа «Приложение для компьютера»).');
  process.exit(1);
}
const state = randomBytes(16).toString('hex');
const server = http.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/drive.file',
  access_type: 'offline',
  prompt: 'consent',
  state,
})}`;
console.log('\nОткройте в браузере на этом компьютере:\n');
console.log(url, '\n');
server.on('request', async (req, res) => {
  const params = new URL(req.url, redirectUri).searchParams;
  if (params.get('state') !== state || !params.get('code')) {
    res.end('Неверный ответ. Закройте вкладку и попробуйте ещё раз.');
    return;
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: params.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const data = await response.json();
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  if (!data.refresh_token) {
    res.end('Google не выдал refresh token. Закройте вкладку и посмотрите терминал.');
    console.error('Ошибка:', data.error ?? data, '\nПопробуйте ещё раз (prompt=consent уже включён).');
  } else {
    res.end('Готово. Вернитесь в терминал.');
    console.log('GOOGLE_DRIVE_REFRESH_TOKEN (вставьте в Environment на Render):\n');
    console.log(data.refresh_token);
  }
  server.close();
});
