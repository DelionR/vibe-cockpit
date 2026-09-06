#!/usr/bin/env node
/**
 * PreToolUse-хук для агентов (Write/Edit/ApplyPatch): при записи в файл без
 * аренды автоматически берёт короткую аренду от имени агента — тогда в ленте
 * панели видно, КТО менял файлы. Всегда завершается кодом 0 (мягкий режим).
 *
 * Регистрация: hooks → PreToolUse (user scope, ~/.zcode/cli/config.json).
 * Имя агента: переменная окружения VIBE_AGENT, иначе session-<id>.
 */

import { handlePreToolUse } from '../src/write-hook.js';
import { loadState } from '../src/store.js';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw || '{}');
    let projects = [];
    try {
      projects = (await loadState())?.projects || [];
    } catch { /* состояния нет — атрибутируем только по арендам */ }
    await handlePreToolUse(input, { projects, env: process.env });
  } catch {
    /* мягкий режим: любая ошибка хука не блокирует запись */
  }
  process.exit(0);
});
