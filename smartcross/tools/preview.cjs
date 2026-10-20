// Usage: node tools/preview.cjs src/module.js [--fn demo] [--out previews/name] [--t 0] [--views '[{"pos":[x,y,z],"target":[x,y,z]}]'] [--w 1280 --h 720] [--ground 0]
// Renders the object returned by the module's function (default `demo`) with the project's sun/sky setup
// from 4 auto views (or custom views) and writes <out>-<i>.png. Prints draw calls, triangles, bbox and errors.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
const argv = process.argv.slice(2);
const mod = argv[0];
const opt = k => { const i = argv.indexOf('--' + k); return i > -1 ? argv[i + 1] : undefined; };
const out = opt('out') || 'previews/' + path.basename(mod, '.js');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
server.listen(0, async () => {
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const w = +(opt('w') || 1280), h = +(opt('h') || 720);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  const qs = new URLSearchParams({ mod, fn: opt('fn') || 'demo', w, h });
  if (opt('views')) qs.set('views', opt('views'));
  if (opt('ground')) qs.set('ground', opt('ground'));
  if (opt('fov')) qs.set('fov', opt('fov'));
  try {
    await page.goto(`http://127.0.0.1:${port}/tools/preview.html?${qs}`);
    await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });
    const n = await page.evaluate('window.__count');
    const t = +(opt('t') || 0);
    fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
    let info;
    for (let i = 0; i < n; i++) {
      info = await page.evaluate(([i, t]) => window.__shot(i, t), [i, t]);
      await page.screenshot({ path: path.join(root, `${out}-${i}.png`) });
    }
    console.log(JSON.stringify(info));
    console.log('wrote ' + n + ' images: ' + out + '-0..' + (n - 1) + '.png');
  } catch (e) { console.log('ERROR ' + e.message); }
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  await browser.close(); server.close();
});
