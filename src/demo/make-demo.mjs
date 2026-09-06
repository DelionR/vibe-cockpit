// Генератор демо-состояния панели (входит в изолированный модуль src/demo/).
//
// Сканирует examples/sample-projects (синтетические проекты-примеры) и
// сохраняет валидный state.json в examples/demo-state.json. Используется
// демо-режимом (bin/vibe-demo.js) для показа дашборда на вымышленных
// данных без сканирования реальных проектов пользователя.
//
// Запуск: node src/demo/make-demo.mjs
// Важно: не вызывает saveState(), поэтому не трогает .vibe панели.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scan } from '../scanner.js';
import { enrichWithGit } from '../git.js';
import { buildState } from '../store.js';
import { defaultConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', 'examples', 'sample-projects');
const out = path.resolve(__dirname, '..', '..', 'examples', 'demo-state.json');

const cfg = defaultConfig();
cfg.roots = [root];

console.log('Сканирую примеры проектов:', root);
const result = await scan(cfg, (p) => {
  if (p.phase === 'roots') console.log('  поиск проектов…');
});
try {
  await enrichWithGit(result.projects);
} catch (e) {
  console.warn('  git-обогащение пропущено:', e.message);
}
const state = buildState(result, cfg);
state.generatedAt = new Date().toISOString();
state.isDemo = true;
await fs.writeFile(out, JSON.stringify(state, null, 2));
console.log(
  `Готово: ${state.projects.length} проектов, ${state.dupGroups.length} групп клонов → ${
    path.relative(process.cwd(), out)
  }`,
);
