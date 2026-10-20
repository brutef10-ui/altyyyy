// Renders shots of dist/smartcross.html: node tools/shoot.cjs [--shots 0,1,2] [--out previews/shot] [--w 1600 --h 900] [--fly]
// Without --fly each shot is jumped to directly; with --fly the deck is navigated with ArrowRight and also
// captures mid-flight frames. CDN URLs are served from node_modules.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : undefined; };
const out = opt('out') || 'previews/shot';
const w = +(opt('w') || 1600), h = +(opt('h') || 900);
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  fs.createReadStream(p).pipe(res);
});
server.listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w + 40, height: h + 40 } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  await page.route('https://cdn.jsdelivr.net/npm/three@0.169.0/**', r => {
    const rel = r.request().url().split('three@0.169.0/')[1];
    r.fulfill({ path: path.join(root, 'node_modules/three', rel), contentType: 'text/javascript' });
  });
  await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ path: path.join(root, 'node_modules/gsap/dist/gsap.min.js'), contentType: 'text/javascript' }));
  await page.route('https://fonts.**/**', r => r.abort());
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/dist/smartcross.html`);
  try {
    await page.waitForFunction('window.__sc', null, { timeout: 300000 });
  } catch (e) { console.log('TIMEOUT waiting for world', logs.join('\n')); process.exit(1); }
  console.log('world ready in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  const stage = await page.$('#stage');
  const shots = (opt('shots') || '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14').split(',').map(Number);
  await page.waitForTimeout(2500);
  if (argv.includes('--fly')) {
    for (const n of shots) {
      if (n > 0) await page.evaluate(n => window.__sc.go(n), n);
      await page.waitForTimeout(1200);
      await stage.screenshot({ path: path.join(root, `${out}-${n}-mid.png`) });
      await page.waitForFunction('!window.__sc.state().busy', null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      await stage.screenshot({ path: path.join(root, `${out}-${n}.png`) });
    }
  } else {
    for (const n of shots) {
      await page.evaluate(n => window.__sc.jump(n), n);
      await page.waitForTimeout(2600);
      await stage.screenshot({ path: path.join(root, `${out}-${n}.png`) });
    }
  }
  const info = await page.evaluate(() => { const c = document.getElementById('gl'); return { w: c.width, h: c.height }; });
  console.log('canvas', JSON.stringify(info));
  console.log(logs.slice(0, 30).join('\n'));
  await browser.close(); server.close();
});
