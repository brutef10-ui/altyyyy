// Сравнение режимов без браузера: node simulation/benchmark.mjs
// Берёт движок прямо из index.html, чтобы цифры совпадали с тем, что видно на экране.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const src = html.split('/* ENGINE START */')[1].split('/* ENGINE END */')[0];
const E = new Function(`${src}\nreturn { createSim, stepSim, setAI, metrics };`)();

const DT = 0.1;
const SCENARIOS = {
  'Час пик с запада': { W: 26, E: 17, N: 9, S: 7 },
  'Час пик с севера': { W: 9, E: 7, N: 26, S: 17 },
  'Равномерно': { W: 14, E: 14, N: 14, S: 14 },
};

function run(demand, aiFrom, minutes, seed) {
  const sim = E.createSim({ seed, demand, fixed: { EW: 30, NS: 30 } });
  const rows = [];
  for (let min = 1; min <= minutes; min++) {
    if (aiFrom != null && min - 1 === aiFrom) E.setAI(sim, true);
    for (let i = 0; i < 60 / DT; i++) E.stepSim(sim, DT);
    const m = E.metrics(sim);
    rows.push({ min, waiting: m.waiting, delay: m.delay, maxLen: m.maxLen, ai: sim.ai.on });
  }
  return rows;
}

const fmt = (r) => `${String(r.min).padStart(3)} мин  ${r.ai ? 'ИИ ' : 'фикс'}  ждут ${String(r.waiting).padStart(3)}  задержка ${String(Math.round(r.delay ?? 0)).padStart(4)} с  очередь ${String(Math.round(r.maxLen)).padStart(4)} м`;

const verbose = process.argv.includes('--verbose');
for (const [name, demand] of Object.entries(SCENARIOS)) {
  console.log(`\n=== ${name} (маш/мин: ${JSON.stringify(demand)}) ===`);
  const mixed = run(demand, 10, 30, 7);
  if (verbose) mixed.forEach((r) => console.log(fmt(r)));

  // Среднее по последним 10 минутам, по нескольким случайным потокам.
  const seeds = [1, 2, 3, 4, 5];
  const avg = (ai) => {
    let w = 0, d = 0, q = 0, n = 0;
    for (const s of seeds) {
      for (const r of run(demand, ai ? 0 : null, 30, s).slice(-10)) { w += r.waiting; d += r.delay ?? 0; q += r.maxLen; n++; }
    }
    return { w: w / n, d: d / n, q: q / n };
  };
  const f = avg(false), a = avg(true);
  const pct = (x, y) => {
    const v = Math.round((1 - y / x) * 100);
    return v >= 0 ? `−${v}%` : `+${-v}%`;
  };
  console.log(`Обычный светофор: ждут ${f.w.toFixed(1)}, задержка ${f.d.toFixed(0)} с, макс. очередь ${f.q.toFixed(0)} м`);
  console.log(`ИИ-регулировщик:  ждут ${a.w.toFixed(1)}, задержка ${a.d.toFixed(0)} с, макс. очередь ${a.q.toFixed(0)} м`);
  console.log(`Изменение с ИИ: ожидающих ${pct(f.w, a.w)}, задержка ${pct(f.d, a.d)}, очередь ${pct(f.q, a.q)}`);
}
