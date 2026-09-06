/**
 * Калибровка весов readiness-скора (Приоритет 1).
 *
 * Показывает, какие компоненты реально дифференцируют проекты, а какие
 * вырождены (у всех максимум или у всех ноль) — их вес потрачен впустую.
 *
 * Запуск: node tools/score-calib.mjs [--top N]
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScore, stageOf, STAGE_LABEL, PART_MAX, DEFAULT_SCORE_WEIGHTS } from '../src/score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(here, '..', '.vibe', 'state.json');

// Максимум компоненты — её вес (скор = сумма весов). PART_MAX остался мерой
// «сырых» баллов формулы и для диагностики насыщения больше не годится.
const PARTS_MAX = { ...DEFAULT_SCORE_WEIGHTS };
void PART_MAX;

const state = JSON.parse(await readFile(STATE, 'utf8'));
const projects = (state.projects || []).map((p) => ({ p, s: computeScore(p) }));

const topN = Number(process.argv[2]) || 0;

console.log(`Проектов: ${projects.length}\n`);

// --- 1. Вклад каждой компоненты: среднее, разброс, доля насыщения ---
console.log('== Компоненты скора ==');
console.log('компонент   макс  средн   мин   макс_факт  насыщ.макс  нулей  вклад в разброс');

const keys = Object.keys(PARTS_MAX);
const stats = keys.map((k) => {
  const vals = projects.map(({ s }) => s.parts[k] || 0);
  const max = PARTS_MAX[k];
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const min = Math.min(...vals);
  const maxFact = Math.max(...vals);
  const satMax = vals.filter((v) => v >= max).length / vals.length;
  const zeros = vals.filter((v) => v === 0).length / vals.length;
  // разброс относительно собственного максимума — насколько компонента «работает»
  const spread = (maxFact - min) / max;
  return { k, max, mean, min, maxFact, satMax, zeros, spread, vals };
});

for (const st of stats) {
  console.log(
    `${st.k.padEnd(10)} ${String(st.max).padStart(4)} ${st.mean.toFixed(1).padStart(6)} ` +
    `${String(st.min).padStart(5)} ${String(st.maxFact).padStart(10)} ` +
    `${(st.satMax * 100).toFixed(0).padStart(10)}% ${(st.zeros * 100).toFixed(0).padStart(6)}% ` +
    `${(st.spread * 100).toFixed(0).padStart(15)}%`,
  );
}

console.log('\nПояснение: «насыщ.макс» — доля проектов, взявших полный балл компоненты.');
console.log('Если она велика, компонента не различает проекты. «Вклад в разброс» —');
console.log('какую долю своего диапазона компонента реально использует.\n');

// --- 2. Распределение по стадиям ---
console.log('== Распределение по стадиям ==');
const byStage = new Map();
for (const { p, s } of projects) {
  const st = stageOf(s.score);
  if (!byStage.has(st)) byStage.set(st, []);
  byStage.get(st).push({ p, s });
}
for (const st of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']) {
  const list = byStage.get(st) || [];
  const bar = '#'.repeat(Math.min(40, list.length));
  console.log(`${st} ${STAGE_LABEL[st].padEnd(8)} ${String(list.length).padStart(3)} ${bar}`);
}

// --- 3. Кандидаты на перекос: высокий скор при пустых тестах/гите ---
console.log('\n== Подозрительные: высокий скор без тестов и/или без git ==');
const suspicious = projects
  .filter(({ p, s }) => s.score >= 60 && ((p.testFiles || 0) === 0 || !p.git))
  .sort((a, b) => b.s.score - a.s.score);
for (const { p, s } of suspicious) {
  const bits = [];
  if ((p.testFiles || 0) === 0) bits.push('нет тестов');
  if (!p.git) bits.push('нет git');
  console.log(`  ${String(s.score).padStart(3)} ${p.name.slice(0, 40).padEnd(42)} ${bits.join(', ')}`);
}
console.log(`  итого: ${suspicious.length}`);

// --- 4. Детальная таблица (по запросу --top N) ---
if (topN > 0) {
  console.log(`\n== Топ-${topN} по скору (детально) ==`);
  const sorted = [...projects].sort((a, b) => b.s.score - a.s.score).slice(0, topN);
  console.log('скор стадия проект'.padEnd(60) + keys.map((k) => k.slice(0, 5).padStart(6)).join(''));
  for (const { p, s } of sorted) {
    const head = `${String(s.score).padStart(3)} ${s.stage}   ${p.name.slice(0, 45).padEnd(47)}`;
    console.log(head + keys.map((k) => String(s.parts[k] || 0).padStart(6)).join(''));
  }
}
