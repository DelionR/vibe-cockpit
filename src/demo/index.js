// Изолированный демо-модуль панели vibe-cockpit.
//
// Раньше демо-ветки жили прямо в src/serve.js через `if (demo)`. Теперь это
// отдельный модуль: он импортирует ТОЛЬКО `serve` как нейтральную библиотеку
// (из ../serve.js) и подставляет собственный объект `deps` с мок-данными.
//
// Граница изоляции (жёстко):
//   - production-код (src/serve.js, src/cli.js, ...) НЕ импортирует src/demo/.
//   - src/demo НЕ импортирует store/leases/config панели — только serve().
//   - демо-данные лежат в examples/demo-state.json (генерит make-demo.mjs) и
//     не читают/не пишут реальный .vibe панели.
//
// Запуск: bin/vibe-demo.js → src/demo/index.js → startDemo().

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '../serve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_STATE_PATH = path.resolve(__dirname, '..', '..', 'examples', 'demo-state.json');

let demoStateCache = null;

/** Читает статичный демо-state.json (синтетические проекты). Кэшируется. */
async function loadDemoState() {
  if (!demoStateCache) {
    const raw = await fs.readFile(DEMO_STATE_PATH, 'utf8');
    demoStateCache = JSON.parse(raw);
  }
  return demoStateCache;
}

/**
 * Синтетические аренды для демонстрации бейджей на дашборде.
 * Форма совпадает с buildLeasesView(): projectName, rel, owner, reason,
 * acquiredAt, expiresAt, leftMs, whole.
 */
function demoLeases() {
  const now = Date.now();
  const min = 60 * 1000;
  const mk = (id, projectName, rel, owner, reason, agoMin, ttlMin) => ({
    id,
    projectName,
    rel,
    owner,
    reason,
    acquiredAt: new Date(now - agoMin * min).toISOString(),
    expiresAt: new Date(now + (ttlMin - agoMin) * min).toISOString(),
    leftMs: Math.max(0, (ttlMin - agoMin) * min),
    whole: rel === '.',
  });
  return [
    mk('demo-lease-1', 'quantum-ledger', '.', 'Алиса (демо)', 'Переписываю ядро ledger', 12, 30),
    mk('demo-lease-2', 'salebot-classic', 'src/bot.js', 'Боб (демо)', 'Правлю обработчик команд', 3, 30),
  ];
}

/**
 * deps для демо-режима: всё read-only, скан и отчёты имитируются.
 * Никакой логики панели внутри — только мок-ответы.
 */
export function demoDeps() {
  return {
    readonly: true,
    readonlyMessage: 'Демо-режим: настройки только для чтения',
    disableOpen: true,
    openDisabledMessage: 'Демо-режим: открытие папок отключено',
    disableWatch: true,
    loadState: loadDemoState,
    buildLog: async () => [],
    buildLeases: async () => demoLeases(),
    conflictsCount: async () => 0,
    applyConfigPatch: async () => {
      const e = new Error('Демо-режим: настройки только для чтения');
      e.status = 403;
      throw e;
    },
    startScan: async ({ broadcastScanStatus, broadcastLog, refresh }) => {
      // Имитация «сканирования» без реального обхода файловой системы.
      broadcastScanStatus();
      broadcastLog('Демо: обновление данных отключено');
      setTimeout(() => {
        broadcastScanStatus();
        if (refresh) refresh(new Date().toISOString());
      }, 600);
      return { status: 202, body: { ok: true, demo: true } };
    },
    writeReport: async () => {
      const e = new Error('Демо-режим: отчёты не формируются');
      e.status = 403;
      throw e;
    },
  };
}

/**
 * Точка входа демо-режима. Поднимает тот же HTTP-сервер, что и production,
 * но с мок-deps. Не трогает конфиг/state пользователя.
 */
export async function startDemo({ port = 5173, host = '127.0.0.1' } = {}) {
  const server = await serve({ port, host, deps: demoDeps() });
  const addr = server.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : port;
  console.log(`◈ Демо-режим: данные из examples/demo-state.json (только просмотр) → http://${host}:${boundPort}`);
  return server;
}
