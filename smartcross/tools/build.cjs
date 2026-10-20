// Bundles src/main.js (+ modules) and inlines it into src/template.html → dist/smartcross.html
const fs = require('fs'), path = require('path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
(async () => {
  const r = await esbuild.build({
    entryPoints: [path.join(root, 'src/main.js')], bundle: true, format: 'esm', target: 'es2022', write: false,
    external: ['three', 'three/addons/*'],
    plugins: [{ name: 'stubs', setup(b) {
      // until a real model module exists in src/, resolve it to its stub (for early integration tests)
      b.onResolve({ filter: /^\.\/(vehicles|buildings|nature|people|roads|devices|logo)\.js$/ }, a => {
        const real = path.join(root, 'src', a.path.slice(2));
        if (fs.existsSync(real) && !process.env.STUBS) return { path: real };
        console.log('  stub:', a.path);
        return { path: path.join(root, 'stubs', a.path.slice(2)) };
      });
    } }],
    minifyWhitespace: true, minifySyntax: true, legalComments: 'none', logLevel: 'warning',
  });
  const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const tpl = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const out = tpl.replace('/*__BUNDLE__*/', () => js);
  fs.writeFileSync(path.join(root, 'dist/smartcross.html'), out);
  console.log('dist/smartcross.html', (out.length / 1024).toFixed(0) + ' KB');
})().catch(e => { console.error(e.message); process.exit(1); });
