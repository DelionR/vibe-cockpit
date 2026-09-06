// Генератор демо-состояния панели.
//
// Сканирует examples/sample-projects (синтетические проекты-примеры) и
// сохраняет валидный state.json в examples/demo-state.json. Используется
// демо-режимом `vibe serve --demo`, чтобы показать дашборд на вымышленных
// данных без сканирования реальных проектов пользователя.
//
// Важно: не вызывает saveState(), поэтому не трогает .vibe панели.

import path from 'node:path';
import fs from 'node:fs/promises';
import { scan } from '../src/scanner.js';
import { enrichWithGit } from '../src/git.js';
import { buildState } from '../src/store.js';
import { defaultConfig } from '../src/config.js';

const here = path.resolve(import.meta.dirname);
const root = path.join(here, '..', 'examples', 'sample-projects');
const out = path.join(here, '..', 'examples', 'demo-state.json');

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
