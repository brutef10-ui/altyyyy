// Loads dist/smartcross.html, reports errors, then flies shot 0 → 1 → 2 and reports state.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const server = http.createServer((req, res) => { const p = path.join(root, req.url.split('?')[0]); if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(p).pipe(res); });
server.listen(0, async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await b.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
  await page.route('https://cdn.jsdelivr.net/npm/three@0.169.0/**', r => r.fulfill({ path: path.join(root, 'node_modules/three', r.request().url().split('three@0.169.0/')[1]), contentType: 'text/javascript' }));
  await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ path: path.join(root, 'node_modules/gsap/dist/gsap.min.js'), contentType: 'text/javascript' }));
  await page.route('https://fonts.**/**', r => r.abort());
  await page.goto(`http://127.0.0.1:${server.address().port}/dist/smartcross.html`);
  try { await page.waitForFunction('window.__sc', null, { timeout: 120000 }); console.log('world ok'); } catch (e) { console.log('NO WORLD'); }
  for (const n of [1, 2]) {
    await page.evaluate(n => window.__sc.go(n), n);
    try { await page.waitForFunction('!window.__sc.state().busy', null, { timeout: 120000 }); console.log('flight to', n, 'ok', JSON.stringify(await page.evaluate(() => window.__sc.state()))); } catch (e) { console.log('flight stuck', n); }
  }
  await b.close(); server.close();
});
