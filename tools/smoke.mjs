#!/usr/bin/env node
/**
 * Smoke-тест панели: поднимает сервер на свободном порту и проверяет
 * все публичные точки входа. Запускать после любых правок src/:
 *
 *   node tools/smoke.mjs
 *
 * Выход 0 — всё зелёное, 1 — есть провалы.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, buildView, describeEvent, buildCleanupView, buildBriefText, sanitizeConfigPatch } from '../src/serve.js';
import { applyMarkers } from '../src/scanner.js';
import { loadState, buildState, rebuildDupGroupsForProject, buildCleanupReport, appendEvent, applyCloneValueInheritance } from '../src/store.js';
import { EVENTS_PATH } from '../src/config.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { renderMarkdown, renderHtml } from '../src/report.js';
import { computeScore, stageOf, DEFAULT_SCORE_WEIGHTS, normalizeScoreWeights, PART_MAX } from '../src/score.js';
import { detectProjectKind } from '../src/detect.js';
import {
  computeValue, computeValuePriority, valueTier, detectMonetizationSignal, manualValue,
  VALUE_TIERS,
} from '../src/value.js';
import { normalizeContent, minhashSignature, signatureSimilarity, findNearGroups } from '../src/dup.js';
import {
  acquireLease, releaseLease, loadLeases, activeLeases, findLease, readConflicts,
} from '../src/leases.js';
import { handlePreToolUse } from '../src/write-hook.js';
import { leasedFilesFor } from '../src/watch.js';
import { run, writeAgentRules } from '../src/cli.js';
import { appendHandoff, loadHandoffs, latestHandoffForProject, latestHandoffForTarget } from '../src/handoff.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL_ROOT = path.resolve(here, '..');
// Рантайм берём из процесса, а не хардкодом: managed-Node обновляется
// (22.22.2-1 → 22.22.2-2) и зашитый путь ломает весь прогон spawn ENOENT.
const MCP_NODE = process.execPath;

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function get(port, urlPath) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function main() {
  console.log('\n== Состояние ==');
  const state = await loadState();
  check('state.json читается', !!state, 'выполните: node bin/vibe.js scan');
  if (!state) {
    console.log('\nНет состояния — тест прерван.');
    process.exit(1);
  }
  check('в состоянии есть проекты', Array.isArray(state.projects) && state.projects.length > 0);
  check('в состоянии есть dupGroups', Array.isArray(state.dupGroups));
  check('у проектов посчитан скор', state.projects.every((p) => typeof p.score === 'number'));

  console.log('\n== Отчёты ==');
  const md = renderMarkdown(state);
  const html = renderHtml(state);
  check('Markdown рендерится', md.length > 500, `${md.length} симв.`);
  check('HTML рендерится', html.startsWith('<!doctype html>'), `${html.length} симв.`);

  console.log('\n== Скор ==');
  const s0 = computeScore({ has: {}, stack: [], names: [], codeFiles: 0, loc: 0, lastActivityAt: null, git: null });
  const fullProject = () => ({
    has: { readme: true, spec: true, lockfile: true, config: true, gitignore: true, envExample: true, docker: true, ci: true, tests: true, agentContext: true },
    stack: ['node', 'tests'], names: ['Makefile', 'package.json'], codeFiles: 50, loc: 5000,
    testFiles: 10, lastActivityAt: new Date().toISOString(), git: { remote: 'x' },
  });
  const sMax = computeScore(fullProject());
  check('пустой проект даёт низкий скор', s0.score < 20, `score=${s0.score}`);
  check('полный проект даёт высокий скор', sMax.score >= 80, `score=${sMax.score}`);
  check('stageOf(0) === S0', stageOf(0) === 'S0');
  check('stageOf(100) === S5', stageOf(100) === 'S5');

  console.log('\n== Веса скора (калибровка, Приоритет 1) ==');
  check('веса по умолчанию покрывают все компоненты',
    Object.keys(PART_MAX).every((k) => k in DEFAULT_SCORE_WEIGHTS));
  check('сумма весов по умолчанию = 100',
    Object.values(DEFAULT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0) === 100,
    `сумма=${Object.values(DEFAULT_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)}`);
  const sHeavyTests = computeScore(fullProject(), { ...DEFAULT_SCORE_WEIGHTS, tests: 40 });
  check('вес компоненты поднимает её вклад', sHeavyTests.parts.tests > sMax.parts.tests,
    `${sHeavyTests.parts.tests} против ${sMax.parts.tests}`);
  const sNoCore = computeScore(fullProject(), { ...DEFAULT_SCORE_WEIGHTS, core: 0 });
  check('нулевой вес обнуляет компоненту', sNoCore.parts.core === 0, `core=${sNoCore.parts.core}`);
  const wNorm = normalizeScoreWeights({ tests: 'abc', core: 5, nonexistent: 9 });
  check('нормализация отбрасывает нечисловые веса', wNorm.tests === DEFAULT_SCORE_WEIGHTS.tests);
  check('нормализация принимает корректные веса', wNorm.core === 5);
  check('нормализация не пускает чужие ключи', !('nonexistent' in wNorm));
  const patchOk = sanitizeConfigPatch({ score: { weights: { tests: 20 } } });
  check('патч score.weights принимается', !patchOk.error && patchOk.patch.score.weights.tests === 20,
    patchOk.error || '');
  check('патч с неизвестной компонентой отклоняется',
    !!sanitizeConfigPatch({ score: { weights: { nonexistent: 5 } } }).error);
  check('патч с отрицательным весом отклоняется',
    !!sanitizeConfigPatch({ score: { weights: { tests: -3 } } }).error);

  console.log('\n== Маркеры проекта (lockfile / CI) ==');
  const mk = { has: {}, testFiles: 0 };
  applyMarkers(mk, ['package.json', 'package-lock.json', 'README.md', '.github'], 'M:/x/y');
  check('package-lock.json детектится как lockfile', mk.has.lockfile === true);
  check('.github детектится как CI', mk.has.ci === true);
  const mk2 = {};
  applyMarkers(mk2, ['package.json', 'blockchain.js', 'clock.yaml'], 'M:/x/z');
  check('blockchain.js / clock.yaml не ложно детектятся как lockfile',
    mk2.has.lockfile === false && mk2.has.ci === false);
  const mk3 = {};
  applyMarkers(mk3, ['yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'], 'M:/x/w');
  check('yarn.lock / pnpm-lock.yaml / Cargo.lock детектятся', mk3.has.lockfile === true);

  console.log('\n== Детект проектов ==');
  const nestedModule = ['package.json', 'worker.js', '.gitignore'];
  const nestedModuleGit = ['.git', '.gitignore', 'package.json', 'worker.js'];
  const espMain = ['CMakeLists.txt', 'main.c', 'dsp.c', 'dsp.h', 'i2s_mic.c', 'i2s_mic.h', 'board.h'];
  const realNested = ['package.json', 'README.md', 'src', 'public', 'next.config.ts', 'tsconfig.json', 'package-lock.json', 'eslint.config.mjs'];
  check('вложенный модуль (manifest, мало файлов) — не проект',
    detectProjectKind(nestedModule, { parentIsProject: true, dirName: 'node_export_worker' }).reason === 'nested-module-inside-project');
  check('вложенный модуль с .git — тоже не проект',
    detectProjectKind(nestedModuleGit, { parentIsProject: true, dirName: 'node_export_worker' }).reason === 'nested-module-inside-project');
  check('ESP-IDF main (CMakeLists) внутри firmware — не проект',
    detectProjectKind(espMain, { parentIsProject: true, dirName: 'main' }).reason === 'nested-module-inside-project');
  check('вложенный проект с README — проект',
    detectProjectKind(realNested, { parentIsProject: true, dirName: 'analytics-dashboard' }).isProject === true);
  check('вложенный проект с тестами — проект',
    detectProjectKind(['requirements.txt', 'app.py', 'README.md', 'test_app.py', 'static'], { parentIsProject: true, dirName: 'Site_creation_post' }).isProject === true);
  check('тот же модуль на верхнем уровне — проект',
    detectProjectKind(nestedModule, { parentIsProject: false, dirName: 'node_export_worker' }).isProject === true);
  check('служебные файлы панели (.git/AGENTS.md) не делают вложенный каталог проектом',
    detectProjectKind(['.git', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'a.py', 'b.py', 'c.py', 'requirements.txt'],
      { parentIsProject: true, dirName: 'pi' }).reason === 'nested-module-inside-project');
  check('служебное имя внутри проекта по-прежнему не проект',
    detectProjectKind(['package.json', 'index.js'], { parentIsProject: true, dirName: 'src' }).reason === 'generic-dir-inside-project');
  check('backend/claude/evals внутри проекта — служебные, не проекты',
    detectProjectKind(['requirements.txt', 'manage.py', 'app'], { parentIsProject: true, dirName: 'backend' }).reason === 'generic-dir-inside-project' &&
    detectProjectKind(['AGENTS.md', 'commands', 'skills'], { parentIsProject: true, dirName: 'claude' }).reason === 'generic-dir-inside-project' &&
    detectProjectKind(['package.json', 'run.mjs', 'cases'], { parentIsProject: true, dirName: 'evals' }).reason === 'generic-dir-inside-project');
  check('прошивочные компоненты на глубине ≥2 подавляются даже без проекта-родителя',
    detectProjectKind(['main.h', 'sensors.h'], { parentIsProject: false, dirName: 'Inc', depth: 3 }).reason === 'generic-dir-inside-project' &&
    detectProjectKind(['main.c', 'crc.c'], { parentIsProject: false, dirName: 'Src', depth: 3 }).reason === 'generic-dir-inside-project' &&
    detectProjectKind(['.git', 'platformio.ini', 'stm32'], { parentIsProject: false, dirName: 'firmware', depth: 2 }).reason === 'generic-dir-inside-project' &&
    detectProjectKind(['age_uart.py', 'receiver.py', '.git'], { parentIsProject: false, dirName: 'host', depth: 3 }).reason === 'generic-dir-inside-project');
  check('на верхнем уровне служебное имя не блокирует проект',
    detectProjectKind(['package.json', 'index.js'], { parentIsProject: false, dirName: 'web', depth: 1 }).isProject === true);

  console.log('\n== Near-dup (minhash) ==');
  const codeA = [
    'function calcOrder(items, tax) {',
    '  let total = 0;',
    '  for (const item of items) { total += item.price * item.qty; }',
    '  total = Math.max(0, total);',
    '  return total + total * tax;',
    '}',
    'module.exports = { calcOrder };',
  ].join('\n');
  // Вариант с одной дописанной строкой — похож, но не идентичен (sim ≈ 0.9).
  const codeB = `${codeA}\nconsole.log(total);`;
  const codeOther = Array.from({ length: 30 }, (_, i) => `SELECT field_${i} FROM table_${i} WHERE id = ${i};`).join('\n');

  const stripped = normalizeContent('const a = 1; // комментарий\n/* блок\nкомментариев */\nconst b = 2;\n', '.js');
  check('normalizeContent вырезает комментарии', stripped === 'const a = 1;\nconst b = 2;', JSON.stringify(stripped));

  const sigA = minhashSignature(codeA);
  const sigA2 = minhashSignature(`${codeA}\n`);
  check('подпись одинаковых текстов даёт sim 1', signatureSimilarity(sigA, sigA2) === 1);
  const simAB = signatureSimilarity(sigA, minhashSignature(codeB));
  check('похожие тексты дают sim в диапазоне [0.5, 0.99]', simAB >= 0.5 && simAB < 1, `sim=${simAB}`);
  check('непохожие тексты дают sim < 0.5', signatureSimilarity(sigA, minhashSignature(codeOther)) < 0.5);

  const mkFile = (project, rel, text) => ({ project, rel, size: text.length, lines: text.split('\n').length, text });
  const nearGroups = findNearGroups([
    mkFile('proj-a', 'src/order.js', codeA),
    mkFile('proj-b', 'lib/invoice.js', codeB),
    mkFile('proj-c', 'db/queries.sql', codeOther),
  ]);
  check('near-группы находятся для похожих файлов', nearGroups.length === 1, `групп: ${nearGroups.length}`);
  if (nearGroups.length === 1) {
    const g = nearGroups[0];
    check('near-группа: kind=near, drift=1-sim', g.kind === 'near' && Math.abs(g.drift - (1 - g.similarity)) < 0.01);
    check('near-группа межпроектная', g.crossProject && g.projectCount === 2, `projectCount=${g.projectCount}`);
    check('у членов near-группы есть sim', g.members.every((m) => m.sim >= 0.5));
  }
  const noGroups = findNearGroups([mkFile('x', 'a.js', codeA), mkFile('y', 'b.js', codeOther)]);
  check('непохожие файлы не дают групп', noGroups.length === 0, `групп: ${noGroups.length}`);

  console.log('\n== Аренды (M3) ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-leases-'));
    const leasesFile = path.join(tmp, 'leases.json');
    const conflictsFile = path.join(tmp, 'conflicts.jsonl');
    const proj = path.join(tmp, 'proj-a');
    const t0 = Date.now();
    // Все аренды короткие (60 с) — TTL-сценарии проверяются без сна.
    const opts = { filePath: leasesFile, now: t0, ttlMs: 60000 };

    const a1 = await acquireLease({ project: proj, rel: 'src/x.js', owner: 'codex', reason: 'правка', ...opts });
    check('аренда берётся', a1.ok && a1.lease.owner === 'codex');
    const blocked = await acquireLease({ project: proj, rel: 'src/x.js', owner: 'claude', ...opts });
    check('чужая аренда блокирует', !blocked.ok && blocked.clashes[0].owner === 'codex');
    const conflicts = await readConflicts(10, conflictsFile);
    check('блокировка пишется в журнал конфликтов', conflicts.length === 1 && conflicts[0].type === 'blocked');

    const forced = await acquireLease({ project: proj, rel: 'src/x.js', owner: 'claude', force: true, ...opts });
    check('force перехватывает аренду', forced.ok && forced.lease.owner === 'claude' && forced.forced === 1);
    const conflicts2 = await readConflicts(10, conflictsFile);
    check('перехват записан как конфликт', conflicts2[0].type === 'forced' && conflicts2[0].holder === 'codex');

    const sameOwner = await acquireLease({ project: proj, rel: 'src/x.js', owner: 'claude', ...opts });
    check('повторный take обновляет свою аренду, а не плодит дубли',
      sameOwner.ok && (await loadLeases(leasesFile)).leases.length === 1);

    const whole = await acquireLease({ project: proj, rel: '.', owner: 'gemini', force: true, ...opts });
    check('аренда на весь проект перехватывает файловую', whole.ok && whole.forced === 1);

    const t1 = t0 + 61000; // все аренды на 60 с — истекли
    const store = await loadLeases(leasesFile);
    check('просроченные аренды не активны', activeLeases(store, t1).length === 0);
    const afterExpire = await acquireLease({ project: proj, rel: 'src/x.js', owner: 'codex', now: t1, filePath: leasesFile, ttlMs: 60000 });
    check('после TTL файл берётся без конфликта', afterExpire.ok && afterExpire.pruned >= 1);

    const wrongOwner = await releaseLease({ project: proj, rel: 'src/x.js', owner: 'claude', now: t1, filePath: leasesFile });
    check('чужой release отклоняется', !wrongOwner.ok && wrongOwner.reason === 'not-owner');
    const released = await releaseLease({ project: proj, rel: 'src/x.js', owner: 'codex', now: t1, filePath: leasesFile });
    check('владелец освобождает аренду', released.ok);
    check('после release активных аренд нет', activeLeases(await loadLeases(leasesFile), t1).length === 0);

    fs.rmSync(tmp, { recursive: true, force: true });
  }
  {
    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    console.error = (...a) => { out += a.join(' ') + '\n'; };
    try {
      await run(['leases', '--limit', '5']);
      check('vibe leases выполняется', out.includes('Активные аренды'));
      await run(['conflicts', '--limit', '5']);
      check('vibe conflicts выполняется', out.includes('Конфликты аренд'));
    } catch (e) {
      check('CLI аренд выполняется без ошибок', false, e.message);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  console.log('\n== Хук записи (атрибуция) ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hook-'));
    const leasesFile = path.join(tmp, 'leases.json');
    const proj = path.join(tmp, 'proj-a');
    const projects = [{ path: proj, name: 'proj-a' }];
    const t0 = Date.now();
    const env = { VIBE_AGENT: 'gamedesigner', CLAUDE_SESSION_ID: 'sess-abcdef123456' };

    // 1) запись в файл без аренды → автоаренда от имени агента
    const r1 = await handlePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: path.join(proj, 'docs', 'README.md') } },
      { projects, env, now: t0, leasesFile, ttlMs: 60000 },
    );
    check('запись без аренды → автоаренда от имени агента',
      r1.action === 'allow' && r1.reason === 'auto-leased' && r1.owner === 'gamedesigner', JSON.stringify(r1));

    // 2) вторая запись в тот же файл → аренда уже есть, дубля нет
    const r2 = await handlePreToolUse(
      { tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'docs', 'README.md') } },
      { projects, env, now: t0 + 1000, leasesFile, ttlMs: 60000 },
    );
    const store1 = await loadLeases(leasesFile);
    check('повторная запись переиспользует аренду', r2.reason === 'leased' && r2.owner === 'gamedesigner'
      && store1.leases.length === 1, JSON.stringify(r2));

    // 3) без VIBE_AGENT — имя из id сессии
    const r3 = await handlePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: path.join(proj, 'notes.md') } },
      { projects, env: { CLAUDE_SESSION_ID: 'sess-abcdef123456' }, now: t0 + 2000, leasesFile, ttlMs: 60000 },
    );
    check('без VIBE_AGENT владелец = session-<id>', r3.reason === 'auto-leased' && r3.owner === 'session-123456', JSON.stringify(r3));

    // 4) файл вне известных проектов — пропускаем без аренды
    const r4 = await handlePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'C:/somewhere-else/x.js' } },
      { projects, env, now: t0, leasesFile },
    );
    check('вне проектов — пропускаем', r4.reason === 'outside-projects');

    // 5) файл под чужой арендой — разрешаем, но фиксируем нарушение (Приоритет 3)
    const eventsFile = path.join(tmp, 'events.jsonl');
    const conflictsFile = path.join(tmp, 'conflicts.jsonl');
    await acquireLease({ project: proj, rel: 'locked.js', owner: 'codex', ttlMs: 60000, now: t0, filePath: leasesFile });
    const r5 = await handlePreToolUse(
      { tool_name: 'Write', tool_input: { file_path: path.join(proj, 'locked.js') } },
      { projects, env, now: t0 + 3000, leasesFile, conflictsFile, eventsFile, ttlMs: 60000 },
    );
    check('чужая аренда: allow + держатель известен',
      r5.action === 'allow' && r5.reason === 'lease-clash' && r5.holder === 'codex', JSON.stringify(r5));
    const conflicts5 = await readConflicts(50, conflictsFile);
    check('запись под чужой арендой пишется в журнал конфликтов',
      conflicts5.some((c) => c.type === 'write-under-lease' && c.holder === 'codex' && c.requester === 'gamedesigner'),
      JSON.stringify(conflicts5));
    const ev5 = fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    check('нарушение попадает в живую ленту (confirmed)',
      ev5.some((e) => e.type === 'lease.violation' && e.payload.confirmed === true
        && e.payload.requester === 'gamedesigner' && e.payload.holder === 'codex'),
      JSON.stringify(ev5.slice(-1)));

    // 5b) владелец пишет в свой файл — нарушения НЕТ
    const r5b = await handlePreToolUse(
      { tool_name: 'Edit', tool_input: { file_path: path.join(proj, 'docs', 'README.md') } },
      { projects, env, now: t0 + 4000, leasesFile, conflictsFile, eventsFile, ttlMs: 60000 },
    );
    check('владелец пишет в свою аренду — нарушения нет', r5b.reason === 'leased');
    const conflicts5b = await readConflicts(50, conflictsFile);
    check('запись владельца не множит конфликты', conflicts5b.length === conflicts5.length,
      `${conflicts5b.length} против ${conflicts5.length}`);

    // 6) нет пути в tool_input — просто allow
    const r6 = await handlePreToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' } }, { projects, env, now: t0, leasesFile });
    check('запись без пути — allow/no-path', r6.reason === 'no-path');

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n== Детектор записи под арендой в watch (Приоритет 3) ==');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-watch-'));
    const leasesFile = path.join(tmp, 'leases.json');
    const proj = path.join(tmp, 'proj-w');
    const t0 = Date.now();
    await acquireLease({ project: proj, rel: 'src/core.js', owner: 'codex', ttlMs: 60000, now: t0, filePath: leasesFile });
    await acquireLease({ project: path.join(tmp, 'proj-other'), rel: '.', owner: 'zcode', ttlMs: 60000, now: t0, filePath: leasesFile });

    const hit = await leasedFilesFor(proj, ['src/core.js'], { now: t0 + 100, leasesFile });
    check('изменение файла под арендой находит держателя',
      hit.length === 1 && hit[0].holder === 'codex' && hit[0].rel === 'src/core.js', JSON.stringify(hit));

    const nested = await leasedFilesFor(proj, ['src/core.js'], { now: t0 + 100, leasesFile });
    check('покрытие считается по rel аренды', nested[0]?.files?.[0] === 'src/core.js');

    const other = await leasedFilesFor(proj, ['docs/readme.md'], { now: t0 + 100, leasesFile });
    check('файл без аренды — попаданий нет', other.length === 0, JSON.stringify(other));

    const otherProj = await leasedFilesFor(proj, ['anything.js'], { now: t0 + 100, leasesFile });
    check('аренда чужого проекта не засчитывается', otherProj.length === 0, JSON.stringify(otherProj));

    const wholeProject = await leasedFilesFor(path.join(tmp, 'proj-other'), ['anything.js'], { now: t0 + 100, leasesFile });
    check('аренда на проект целиком покрывает любой файл',
      wholeProject.length === 1 && wholeProject[0].holder === 'zcode' && wholeProject[0].rel === '.',
      JSON.stringify(wholeProject));

    const expired = await leasedFilesFor(proj, ['src/core.js'], { now: t0 + 120000, leasesFile });
    check('просроченная аренда не считается', expired.length === 0, JSON.stringify(expired));

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\n== Сборка состояния (kind/drift) ==');
  const cfg = { roots: ['M:/a'], ignore: [], ignoreFiles: [], maxDepth: 4, maxFilesPerProject: 100, dup: {} };
  const synthetic = {
    projects: [
      { path: 'M:/a/proj-a', name: 'proj-a', stack: [], files: 1, codeFiles: 1, testFiles: 0, loc: 10, bytes: 100, locByLang: { JS: 10 }, has: { readme: true }, names: [], lastMtimeMs: Date.now() },
      { path: 'M:/b/proj-b', name: 'proj-b', stack: [], files: 1, codeFiles: 1, testFiles: 0, loc: 10, bytes: 100, locByLang: { JS: 10 }, has: {}, names: [], lastMtimeMs: Date.now() },
    ],
    dupGroups: [{
      kind: 'near', hash: null, similarity: 0.9, drift: 0.1, lines: 6, size: 120,
      members: [
        { project: 'M:/a/proj-a', rel: 'src/order.js', size: 120, lines: 6, sim: 0.9 },
        { project: 'M:/b/proj-b', rel: 'lib/invoice.js', size: 120, lines: 6, sim: 0.9 },
      ],
      projectCount: 2, crossProject: true,
    }],
    stats: { dirsVisited: 2, projectsFound: 2, dupGroupsFound: 1, exactGroupsFound: 0, nearGroupsFound: 1, nearDupMs: 1, elapsedMs: 5 },
  };
  const st = buildState(synthetic, cfg);
  check('buildState переносит kind/similarity/drift',
    st.dupGroups[0].kind === 'near' && st.dupGroups[0].similarity === 0.9 && st.dupGroups[0].drift === 0.1);
  check('buildState переносит sim членов', st.dupGroups[0].members.every((m) => m.sim === 0.9));
  check('near-группа увеличивает dupLines проекта', st.projects.every((p) => p.dupLines === 6));
  check('канон размечен ровно один', st.dupGroups[0].members.filter((m) => m.isCanonical).length === 1);
  check('wastedBytes = размер неканонической копии', st.dupGroups[0].wastedBytes === 120);

  console.log('\n== Кандидаты на удаление ==');
  const cleanup = buildCleanupReport(st, { kind: 'exact' });
  const cleanupNear = buildCleanupReport(st, { kind: 'near' });
  check('cleanup считает итог по точным копиям',
    cleanupNear.totalBytes === 120 && cleanupNear.totalFiles === 1 && cleanupNear.projects.length === 1);
  check('cleanup по exact пуст, когда только near-группа', cleanup.totalFiles === 0);
  check('cleanup: проект без канона попадает в целиком неуникальные',
    cleanupNear.noCanonicalProjects.length === 1 && cleanupNear.noCanonicalProjects[0].name === 'proj-b');

  // Точная группа из двух проектов: канон у более ценного проекта.
  const stExact = buildState({
    projects: [
      { path: 'M:/a/weak', name: 'weak', stack: [], files: 1, codeFiles: 1, testFiles: 0, loc: 10, bytes: 100, locByLang: { JS: 10 }, has: {}, names: [], lastMtimeMs: Date.now() },
      { path: 'M:/b/strong', name: 'strong', stack: [], files: 1, codeFiles: 1, testFiles: 0, loc: 500, bytes: 900, locByLang: { JS: 500 }, has: { readme: true }, names: [], lastMtimeMs: Date.now() },
    ],
    dupGroups: [{
      kind: 'exact', hash: 'h1', similarity: 1, drift: 0, lines: 10, size: 100,
      members: [
        { project: 'M:/a/weak', rel: 'x.js', size: 100, lines: 10 },
        { project: 'M:/b/strong', rel: 'y.js', size: 100, lines: 10 },
      ],
      projectCount: 2, crossProject: true,
    }],
    stats: { dirsVisited: 2, projectsFound: 2, dupGroupsFound: 1, exactGroupsFound: 1, nearGroupsFound: 0, nearDupMs: 0, elapsedMs: 5 },
  }, cfg);
  const canonMember = stExact.dupGroups[0].members.find((m) => m.isCanonical);
  check('канон точной группы — проект с большим скором', canonMember.projectId === 'strong');
  const cleanupExact = buildCleanupReport(stExact, { kind: 'exact' });
  check('cleanup точной группы: весь вес на слабом проекте',
    cleanupExact.totalBytes === 100
    && cleanupExact.projects[0].projectId === 'weak'
    && cleanupExact.noCanonicalProjects[0].projectId === 'weak');

  // Пересборка групп после refresh: проект покинул группу → группа распалась
  const stateForRebuild = { dupGroups: [{
    id: 'dup-1', kind: 'exact', hash: 'abc', similarity: 1, drift: 0, lines: 6, size: 120,
    members: [
      { projectId: 'pa', projectPath: 'M:/a/proj-a', rel: 'src/order.js', size: 120, lines: 6 },
      { projectId: 'pb', projectPath: 'M:/b/proj-b', rel: 'lib/invoice.js', size: 120, lines: 6 },
    ],
    projectCount: 2, crossProject: true,
  }] };
  rebuildDupGroupsForProject(stateForRebuild, 'pa', 'M:/a/proj-a', new Map());
  check('ушедший проект распускает группу', stateForRebuild.dupGroups.length === 0);
  const stateKeep = { dupGroups: [{
    id: 'dup-1', kind: 'exact', hash: 'abc', similarity: 1, drift: 0, lines: 6, size: 120,
    members: [
      { projectId: 'pa', projectPath: 'M:/a/proj-a', rel: 'src/order.js', size: 120, lines: 6 },
      { projectId: 'pb', projectPath: 'M:/b/proj-b', rel: 'lib/invoice.js', size: 120, lines: 6 },
    ],
    projectCount: 2, crossProject: true,
  }] };
  rebuildDupGroupsForProject(stateKeep, 'pa', 'M:/a/proj-a', new Map([['abc', [{ rel: 'src/order-v2.js', size: 130, lines: 6 }]]]));
  check('обновлённые файлы остаются в группе', stateKeep.dupGroups.length === 1
    && stateKeep.dupGroups[0].members.some((m) => m.rel === 'src/order-v2.js'));

  console.log('\n== CLI ==');
  {
    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    console.error = () => {};
    try {
      await run(['list', '--sort', 'stage', '--limit', '5']);
      check('vibe list --sort stage выполняется', out.includes('СОРТИРОВКА: STAGE') || out.includes('сортировка: stage'), out.slice(0, 120));
      await run(['dup', '--kind', 'near', '--limit', '3']);
      check('vibe dup --kind near выполняется', out.includes('Похожие файлы') || out.includes('Ничего не найдено'));
      await run(['cleanup', '--limit', '3']);
      check('vibe cleanup выполняется', out.includes('Кандидаты на удаление'));
    } catch (e) {
      check('CLI-команды выполняются без ошибок', false, e.message);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  console.log('\n== Лента (тексты событий) ==');
  {
    const act = describeEvent({ type: 'project.activity', payload: { project: 'pi', owner: 'gamedesigner', files: ['docs/README.md', 'docs/api.md'], score: 14, stage: 'S0' } });
    check('активность читается: кто и какие файлы',
      act.includes('gamedesigner обновляет pi') && act.includes('docs/README.md') && act.includes('скор 14'), act);

    const actNoFiles = describeEvent({ type: 'project.activity', payload: { project: 'pi', owner: null, files: [], score: 14, stage: 'S0' } });
    check('активность без деталей файлов не ломается', actNoFiles.includes('pi'), actNoFiles);

    const ref = describeEvent({ type: 'project.refreshed', payload: { project: 'pi', score: 20, scoreBefore: 14, stage: 'S1' } });
    check('refresh показывает изменение скора', ref.includes('14 → 20') && ref.includes('S1'), ref);

    const refSame = describeEvent({ type: 'project.refreshed', payload: { project: 'pi', score: 14, scoreBefore: 14, stage: 'S0' } });
    check('refresh без изменений пишет «без изменений»', refSame.includes('без изменений'), refSame);

    const leas = describeEvent({ type: 'lease.acquired', payload: { project: 'pi', rel: '.', owner: 'gamedesigner', expiresAt: new Date().toISOString() } });
    check('аренда читается: кто, что, до когда', leas.includes('gamedesigner') && leas.includes('целиком') && leas.includes('аренду'), leas);

    // Дедуп: с dedup:true повтор подавляется, с dedup:false — пишется оба раза
    const tmpEvents = path.join(os.tmpdir(), `vibe-ev-${Date.now()}.jsonl`);
    const payload = { project: 'x', score: 1, stage: 'S0' };
    await appendEvent('project.activity', payload, { dedup: false, filePath: tmpEvents });
    await appendEvent('project.activity', payload, { dedup: false, filePath: tmpEvents });
    await appendEvent('project.activity', payload, { dedup: true, filePath: tmpEvents });
    const txt = fs.readFileSync(tmpEvents, 'utf8').trim().split('\n').length;
    check('dedup:false пишет повторы, dedup:true подавляет', txt === 2, `строк: ${txt}`);
    fs.rmSync(tmpEvents, { force: true });
  }

  console.log('\n== Ось ценности (монетизация) ==');
  {
    // Тир ценности по порогам.
    check('valueTier(100) → M3 Продаёт', valueTier(100).code === 'M3', valueTier(100).label);
    check('valueTier(60) → M2 Монетизируется', valueTier(60).code === 'M2');
    check('valueTier(30) → M1 Идея на продажу', valueTier(30).code === 'M1');
    check('valueTier(0) → M0 Вне бизнеса', valueTier(0).code === 'M0');
    check('VALUE_TIERS упорядочены по убыванию min', VALUE_TIERS.every((t, i) => i === 0 || VALUE_TIERS[i - 1].min > t.min));

    // Авто-детект: платёжный SDK + цена + выложен + коммерческое имя.
    const shop = {
      id: 'shop', path: 'M:/p/my-shop', name: 'my-shop', stack: ['node', 'stripe'], names: ['package.json', 'pricing.html'],
      has: { readme: true, docker: true, ci: true }, git: { remote: 'x' },
    };
    const sig = detectMonetizationSignal(shop);
    check('детект: платёжный SDK даёт сигнал payment', sig.signals.some((s) => s.code === 'payment'));
    check('детект: страница цен даёт сигнал pricing', sig.signals.some((s) => s.code === 'pricing'));
    check('детект: выложен+remote даёт сигнал shipped', sig.signals.some((s) => s.code === 'shipped'));
    check('детект: коммерческое имя даёт сигнал intent', sig.signals.some((s) => s.code === 'intent'));
    check('детект: сумма сигналов ≤ 100', sig.value <= 100, `value=${sig.value}`);

    const dead = { id: 'x', name: 'notes-app', stack: ['node'], names: ['package.json'], has: {}, git: null };
    check('детект: проект без признаков → value 0', detectMonetizationSignal(dead).value === 0);

    // computeValue: ручной вес побеждает авто (ключ — путь проекта, как в UI настроек).
    const cfgM = { monetization: { 'M:/p/my-shop': { value: 95 } } };
    const cv = computeValue(shop, cfgM);
    check('computeValue: ручной вес побеждает авто', cv.value === 95 && cv.source === 'manual');
    check('computeValue: без ручного → авто-сигнал', computeValue(dead, cfgM).source === 'auto');

    // Бизнес-приоритет: монетизация доминирует, готовность модулирует.
    const cfgDef = { rating: { weights: { monetization: 0.6, readiness: 0.4 } } };
    const ideaLanding = { value: 100, score: 0 };
    const readyMoney = { value: 80, score: 90 };
    const pIdea = computeValuePriority(ideaLanding, cfgDef);
    const pReady = computeValuePriority(readyMoney, cfgDef);
    check('приоритет: готовый денежный продукт > идея-лендинг', pReady > pIdea, `${pReady} vs ${pIdea}`);
    check('приоритет: идея-лендинг (V=100,R=0,0.6/0.4) = ровно 60', pIdea === 60, `pIdea=${pIdea}`);
    check('приоритет в диапазоне 0..100', pReady >= 0 && pReady <= 100 && pIdea >= 0 && pIdea <= 100);

    // Веса из конфига применяются.
    const cfgMonOnly = { rating: { weights: { monetization: 1, readiness: 0 } } };
    check('приоритет: readiness=0 → равен value', computeValuePriority(readyMoney, cfgMonOnly) === 80);

    // manualValue: по id, затем по пути.
    const cfgByIdPath = { monetization: { 'by-id': { value: 70 }, 'M:/p/app': { value: 40 } } };
    check('manualValue по id', manualValue({ id: 'by-id' }, cfgByIdPath) === 70);
    check('manualValue по пути', manualValue({ id: 'z', path: 'M:/p/app' }, cfgByIdPath) === 40);
    check('manualValue нет → null', manualValue({ id: 'nope' }, {}) === null);

    // sanitizeConfigPatch принимает monetization и rating.weights.
    const { sanitizeConfigPatch } = await import('../src/serve.js');
    const okPatch = sanitizeConfigPatch({
      monetization: { 'M:/p/app': { value: 85 } },
      rating: { weights: { monetization: 0.7, readiness: 0.3 } },
    });
    check('sanitizeConfigPatch: monetization + rating проходят', !okPatch.error && okPatch.patch.monetization['M:/p/app'].value === 85
      && okPatch.patch.rating.weights.monetization === 0.7, okPatch.error || '');
    const badW = sanitizeConfigPatch({ rating: { weights: { monetization: 2, readiness: -1 } } });
    check('sanitizeConfigPatch: веса вне 0..1 отклоняются', !!badW.error);
    const badM = sanitizeConfigPatch({ monetization: { 'x': { value: 150 } } });
    check('sanitizeConfigPatch: value вне 0..100 отклоняется', !!badM.error);

    // Клон (не-канон точной группы) наследует ценность канона:
    // копия не должна обгонять источник по бизнес-приоритету (был баг с salebot).
    {
      const cfgC = { rating: { weights: { monetization: 0.6, readiness: 0.4 } } };
      const canon = { id: 'src', name: 'source', path: 'M:/p/source', value: 35, valueSource: 'auto', score: 75 };
      const clone = { id: 'clone', name: 'clone', path: 'M:/p/clone', value: 50, valueSource: 'auto', score: 54 };
      canon.valuePriority = computeValuePriority(canon, cfgC);
      const stClone = {
        schema: 3, projects: [canon, clone],
        dupGroups: [{
          kind: 'exact', hash: 'h', similarity: 1, drift: 0, lines: 10, size: 100,
          members: [
            { projectId: 'src', projectPath: 'M:/p/source', rel: 'a.js', size: 100, lines: 10, isCanonical: true },
            { projectId: 'clone', projectPath: 'M:/p/clone', rel: 'a.js', size: 100, lines: 10, isCanonical: false },
          ],
          projectCount: 2, crossProject: true,
        }],
      };
      applyCloneValueInheritance(stClone, cfgC);
      check('клон наследует ценность канона (50→35)', clone.value === 35 && clone.valueSource === 'inherited', `value=${clone.value} src=${clone.valueSource}`);
      check('клон помечен isClone + cloneOf', clone.isClone === true && clone.cloneOf === 'src');
      check('бизнес-приоритет клона < канона', clone.valuePriority < canon.valuePriority, `${clone.valuePriority} vs ${canon.valuePriority}`);

      // Ручной вес ценности клона НЕ переопределяется наследованием.
      const cloneManual = { id: 'clone2', name: 'clone2', path: 'M:/p/clone2', value: 90, valueSource: 'manual', score: 54 };
      const stManual = {
        schema: 3, projects: [canon, cloneManual],
        dupGroups: [{
          kind: 'exact', hash: 'h2', similarity: 1, drift: 0, lines: 10, size: 100,
          members: [
            { projectId: 'src', projectPath: 'M:/p/source', rel: 'a.js', size: 100, lines: 10, isCanonical: true },
            { projectId: 'clone2', projectPath: 'M:/p/clone2', rel: 'a.js', size: 100, lines: 10, isCanonical: false },
          ],
          projectCount: 2, crossProject: true,
        }],
      };
      applyCloneValueInheritance(stManual, cfgC);
      check('ручной вес ценности клона сохраняется', cloneManual.value === 90 && cloneManual.valueSource === 'manual');
    }
  }

  console.log('\n== HTTP ==');
  const server = await serve({ port: 0 });
  const port = server.address().port;
  try {
    const root = await get(port, '/');
    check('GET / отдаёт 200', root.status === 200, `status=${root.status}`);
    check('GET / отдаёт HTML дашборда', root.text.includes('<html') || root.text.includes('<!doctype'));

    const api = await get(port, '/api/state');
    check('GET /api/state отдаёт 200', api.status === 200, `status=${api.status}`);
    let view = null;
    try {
      view = JSON.parse(api.text);
    } catch (e) {
      check('/api/state — валидный JSON', false, e.message);
    }
    if (view) {
      check('/api/state — валидный JSON', true);
      check('view.projects заполнен', Array.isArray(view.projects) && view.projects.length > 0);
      check('view.summary.total совпадает', view.summary.total === state.projects.length,
        `${view.summary.total} vs ${state.projects.length}`);
      check('view.projectDupGroups — массив', Array.isArray(view.projectDupGroups));
      check('view.log — массив', Array.isArray(view.log));
      check('view.dupGroups несут kind/drift', (view.dupGroups || []).every((g) => 'kind' in g && 'drift' in g));
      const p = view.projects[0];
      check('у проекта есть обязательные поля frontend-контракта',
        ['id', 'name', 'path', 'stage', 'score', 'stack', 'isGit', 'hasTests', 'loc', 'files', 'staleDays', 'breakdown', 'dup', 'flags',
          'value', 'valueSource', 'valueTier', 'valuePriority', 'valueSignals']
          .every((k) => k in p),
        `нет: ${['id', 'name', 'path', 'stage', 'score', 'stack', 'isGit', 'hasTests', 'loc', 'files', 'staleDays', 'breakdown', 'dup', 'flags',
          'value', 'valueSource', 'valueTier', 'valuePriority', 'valueSignals'].filter((k) => !(k in p)).join(', ')}`);
    }

    const nf = await get(port, '/nope');
    check('GET /nope отдаёт 404', nf.status === 404, `status=${nf.status}`);

    console.log('\n== Настройки (API) ==');
    {
      const original = await loadConfig();
      try {
        const cfgRes = await fetch(`http://127.0.0.1:${port}/api/config`);
        const cfgData = await cfgRes.json();
        check('GET /api/config отдаёт 200', cfgRes.status === 200, String(cfgRes.status));
        check('в конфиге есть корни и dup', Array.isArray(cfgData.config?.roots) && typeof cfgData.config?.dup === 'object');
        check('панель отдаёт свой путь', typeof cfgData.panelRoot === 'string' && cfgData.panelRoot.length > 0);

        const bad = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roots: [] }),
        });
        check('пустые корни отклоняются (400)', bad.status === 400);

        const badTtl = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leases: { ttlMinutes: 99999 } }),
        });
        check('TTL вне диапазона отклоняется (400)', badTtl.status === 400);

        const good = await fetch(`http://127.0.0.1:${port}/api/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leases: { ttlMinutes: 45 } }),
        });
        const goodData = await good.json();
        check('валидный патч сохраняется (200)', good.status === 200 && goodData.config?.leases?.ttlMinutes === 45);

        const scanGet = await fetch(`http://127.0.0.1:${port}/api/scan`);
        const scanData = await scanGet.json();
        check('GET /api/scan отдаёт статус', scanGet.status === 200 && typeof scanData.running === 'boolean');

        const folders = await fetch(`http://127.0.0.1:${port}/api/folders`);
        const foldersData = await folders.json();
        check('GET /api/folders отдаёт кандидатов корней',
          folders.status === 200 && Array.isArray(foldersData.folders) && foldersData.folders.length > 0,
          `кандидатов: ${(foldersData.folders || []).length}`);

        const badOpen = await fetch(`http://127.0.0.1:${port}/api/open?path=${encodeURIComponent('Z:/точно-не-существует-xyz')}`);
        check('/api/open с несуществующим путём — 400', badOpen.status === 400);
      } finally {
        if (original) await saveConfig(original);
      }
    }

    console.log('\n== Сценарии (API) ==');
    {
      const cleanup = await get(port, '/api/cleanup');
      let cu = null;
      try { cu = JSON.parse(cleanup.text); } catch { /* ниже поймаем */ }
      check('GET /api/cleanup — 200 и валидный JSON', cleanup.status === 200 && !!cu, `status=${cleanup.status}`);
      if (cu) {
        check('cleanup: kind по умолчанию exact', cu.kind === 'exact', String(cu.kind));
        check('cleanup: проекты — массив с wastedBytes',
          Array.isArray(cu.projects) && cu.projects.every((r) => typeof r.wastedBytes === 'number'));
        check('cleanup: wholeProjects — массив', Array.isArray(cu.wholeProjects));
        check('cleanup: nearWastedBytes посчитан', typeof cu.nearWastedBytes === 'number');
        const exactTotal = state.dupGroups.filter((g) => g.kind !== 'near')
          .reduce((a, g) => a + (g.wastedBytes || 0), 0);
        check('cleanup: totalBytes не больше суммы групп', cu.totalBytes <= exactTotal + 1,
          `${cu.totalBytes} vs ${exactTotal}`);
      }

      const cuNear = await get(port, '/api/cleanup?kind=near');
      let cuN = null;
      try { cuN = JSON.parse(cuNear.text); } catch { /* ниже поймаем */ }
      check('GET /api/cleanup?kind=near — 200 и kind=near', cuNear.status === 200 && cuN?.kind === 'near');

      const briefRes = await get(port, '/api/brief');
      let brief = null;
      try { brief = JSON.parse(briefRes.text); } catch { /* ниже поймаем */ }
      check('GET /api/brief — 200 и валидный JSON', briefRes.status === 200 && !!brief, `status=${briefRes.status}`);
      if (brief) {
        check('brief: есть заголовок контекста', String(brief.text).includes('Контекст сессии'));
        check('brief: есть раздел «Требуют решения»', String(brief.text).includes('## Требуют решения'));
        check('brief: есть раздел «Аренды»', String(brief.text).includes('## Аренды'));
        check('brief: есть план действий', String(brief.text).includes('## Что делать дальше'));
      }

      const repGet = await fetch(`http://127.0.0.1:${port}/api/report`);
      check('GET /api/report отклоняется (405)', repGet.status === 405, String(repGet.status));

      const repPost = await fetch(`http://127.0.0.1:${port}/api/report`, { method: 'POST' });
      const rep = await repPost.json().catch(() => ({}));
      check('POST /api/report собирает отчёт (200)', repPost.status === 200 && rep.ok === true,
        `status=${repPost.status} ${rep.error || ''}`);
      check('report: отдаёт ссылки на md и html',
        typeof rep.htmlUrl === 'string' && typeof rep.mdUrl === 'string',
        `${rep.mdUrl} / ${rep.htmlUrl}`);
      if (rep.htmlUrl) {
        const opened = await get(port, rep.htmlUrl);
        check('report: HTML открывается по ссылке', opened.status === 200 && opened.text.includes('<!doctype html>'),
          `status=${opened.status}`);
      }
      // Отчёт — побочный артефакт теста: удаляем, чтобы reports/ не зарастал копиями.
      for (const p of [rep.mdPath, rep.htmlPath]) {
        if (p) { try { fs.rmSync(p, { force: true }); } catch { /* нет файла — и ладно */ } }
      }
      check('report: файлы теста удалены',
        !rep.htmlPath || !fs.existsSync(rep.htmlPath), String(rep.htmlPath));

      const escape = await get(port, '/reports/..%2F.vibe%2Fstate.json');
      check('reports: обход каталога закрыт', escape.status !== 200, `status=${escape.status}`);
    }

    console.log('\n== Сценарии без состояния ==');
    {
      const empty = buildCleanupView(null);
      check('cleanup без состояния — нули, не падение',
        empty.totalBytes === 0 && Array.isArray(empty.projects) && empty.projects.length === 0);
      const emptyBrief = await buildBriefText(null, []);
      check('brief без состояния — понятное сообщение',
        emptyBrief.includes('Контекст сессии') && emptyBrief.includes('запустите сканирование'));
      check('describeEvent знает про report.generated',
        describeEvent({ type: 'report.generated', payload: { html: 'a.html' } }).includes('a.html'));
    }

    console.log('\n== Правила для агентов (AGENTS.md + CLAUDE.md) ==');
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-md-'));
      try {
        const first = await writeAgentRules(tmp, PANEL_ROOT, 'Тестовый проект');
        const agents = fs.readFileSync(first.agentsPath, 'utf8');
        const shim = fs.readFileSync(first.shimPath, 'utf8');

        check('AGENTS.md создан с блоком правил',
          agents.includes('<!-- vibe:leases:start -->') && agents.includes('<!-- vibe:leases:end -->'));
        check('AGENTS.md содержит путь к CLI панели', agents.includes('bin/vibe.js'));
        check('AGENTS.md упоминает команды lease и release',
          agents.includes('lease') && agents.includes('release'));
        check('CLAUDE.md создан с импортом AGENTS.md', shim.includes('@AGENTS.md'));

        // Повторный запуск не должен дублировать ни блок, ни строку импорта.
        await writeAgentRules(tmp, PANEL_ROOT, 'Тестовый проект');
        const agents2 = fs.readFileSync(first.agentsPath, 'utf8');
        const shim2 = fs.readFileSync(first.shimPath, 'utf8');
        const countBlock = (s, m) => s.split(m).length - 1;
        check('повторный запуск не дублирует блок правил',
          countBlock(agents2, '<!-- vibe:leases:start -->') === 1,
          `блоков: ${countBlock(agents2, '<!-- vibe:leases:start -->')}`);
        check('повторный запуск не дублирует строку импорта',
          shim2.split('\n').filter((l) => l.trim() === '@AGENTS.md').length === 1);

        // Существующий CLAUDE.md не затирается — импорт дописывается к содержимому.
        const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-md-'));
        try {
          fs.writeFileSync(path.join(tmp2, 'CLAUDE.md'), '# Мои правила\n\n- не трогать vendor/\n', 'utf8');
          const res = await writeAgentRules(tmp2, PANEL_ROOT, null);
          const existing = fs.readFileSync(res.shimPath, 'utf8');
          check('существующий CLAUDE.md не затёрт',
            existing.includes('не трогать vendor/') && existing.includes('@AGENTS.md'));
        } finally {
          fs.rmSync(tmp2, { recursive: true, force: true });
        }

        // --no-shim: прокладку не создаём.
        const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-agents-md-'));
        try {
          const res = await writeAgentRules(tmp3, PANEL_ROOT, null, { withShim: false });
          check('withShim:false не создаёт CLAUDE.md',
            res.shimPath === null && !fs.existsSync(path.join(tmp3, 'CLAUDE.md')));
          check('withShim:false всё равно пишет AGENTS.md', fs.existsSync(res.agentsPath));
        } finally {
          fs.rmSync(tmp3, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // ── MCP-сервер (M4) ──────────────────────────────────────────────
    console.log('\n== MCP-сервер ==');
    {
      const { handleMessage, startMcpServer, listToolNames } = await import('../src/mcp.js');

      const init = await handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
      }));
      check('initialize возвращает protocolVersion', init.result?.protocolVersion === '2024-11-05');
      check('initialize возвращает serverInfo', init.result?.serverInfo?.name === 'vibe-panel');

      const list = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
      const names = (list.result?.tools || []).map((t) => t.name);
      check('tools/list отдаёт не менее 8 инструментов', names.length >= 8, String(names.length));
      for (const want of ['vibe_status', 'vibe_project', 'vibe_leases', 'vibe_lease_take', 'vibe_brief', 'vibe_refresh']) {
        check(`tools/list содержит ${want}`, names.includes(want));
      }

      // Уведомление не должно возвращать ответ.
      const note = await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      check('notifications/* не даёт ответа', note === null);

      // Неизвестный инструмент — ошибка в поле error (а не result.isError).
      const bad = await handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} },
      }));
      check('неизвестный инструмент — error -32602', bad.error?.code === -32602);

      // Инструмент выполняется и возвращает текст.
      const status = await handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vibe_status', arguments: {} },
      }));
      check('vibe_status возвращает контент-текст',
        typeof status.result?.content?.[0]?.text === 'string'
        && status.result.content[0].text.includes('Проектов'));

      const proj = await handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'vibe_project', arguments: { name: 'salebot' } },
      }));
      check('vibe_project находит проект по имени',
        proj.result?.content?.[0]?.text.includes('salebot'));

      // Ошибка инструмента → result.isError, а не падение сервера.
      const missing = await handleMessage(JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'vibe_project', arguments: { name: 'нет-такого' } },
      }));
      check('vibe_project несуществующий — isError, не крах',
        missing.result?.isError === true);

      // startMcpServer читает stdin и пишет в stdout (прогоняем пайпом).
      const { spawn } = await import('node:child_process');
      const mcpPath = path.join(PANEL_ROOT, 'bin', 'vibe-mcp.js');
      const child = spawn(MCP_NODE, [mcpPath], { cwd: PANEL_ROOT, stdio: ['pipe', 'pipe', 'ignore'] });
      const out = [];
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { out.push(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      });
      const sendMcp = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
      const waitFor = (id) => new Promise((res) => {
        const t = setInterval(() => {
          const m = out.find((l) => { try { return JSON.parse(l).id === id; } catch { return false; } });
          if (m) { clearInterval(t); res(JSON.parse(m)); }
        }, 20);
        setTimeout(() => { clearInterval(t); res(null); }, 5000);
      });
      sendMcp({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} });
      const mi = await waitFor(10);
      check('piped: initialize отвечает', !!mi?.result?.serverInfo);
      sendMcp({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'vibe_leases', arguments: {} } });
      const ml = await waitFor(11);
      check('piped: vibe_leases отвечает', !!ml?.result?.content);
      child.stdin.end();
      await new Promise((r) => child.on('exit', r));

      check('listToolNames для документации', listToolNames().length >= 8);
    }

    // ── Раскатка правил (rollout) ────────────────────────────────────
    console.log('\n== Раскатка правил ==');
    {
      const { pickRolloutTargets, foreignDupShare, ROLLOUT_DEFAULTS } = await import('../src/rollout.js');
      const now = Date.now();

      // Клон исключается, живой источник — остаётся.
      const projects = [
        { id: 'src', name: 'src', path: 'P:/src', lastActivityAt: new Date(now - 2 * 86400000).toISOString(), dupShare: 1 },
        { id: 'clone', name: 'src-mirror', path: 'P:/src-mirror', lastActivityAt: new Date(now - 2 * 86400000).toISOString() },
        { id: 'old', name: 'old', path: 'P:/old', lastActivityAt: new Date(now - 60 * 86400000).toISOString() },
        { id: 'child', name: 'child', path: 'P:/src/child', lastActivityAt: new Date(now - 1 * 86400000).toISOString() },
        { id: 'rootp', name: 'root', path: 'P:/', lastActivityAt: new Date().toISOString() },
      ];
      const groups = [
        { members: [
          { projectId: 'src', lines: 100, isCanonical: true },
          { projectId: 'clone', lines: 100, isCanonical: false },
        ] },
      ];
      const { targets, rejected } = pickRolloutTargets(projects, { roots: ['P:/'], dupGroups: groups, now });
      const names = targets.map((t) => t.project.name).sort();
      check('rollout берёт живой источник', names.includes('src'));
      check('rollout берёт ребёнка через родителя? нет — дочерний пропущен',
        !names.includes('child') && rejected.some((r) => r.name === 'child'));
      check('rollout пропускает клон (по доле чужих строк)', rejected.some((r) => r.name === 'src-mirror'));
      check('rollout пропускает застаревший', rejected.some((r) => r.name === 'old'));
      check('rollout пропускает корень сканирования', rejected.some((r) => r.name === 'root'));

      // Метрика чужих копий.
      const share = foreignDupShare(groups);
      check('foreignDupShare: клон ≈1, источник =0',
        Math.abs(share.get('clone').share - 1) < 0.001 && share.get('src').share === 0);

      check('ROLLOUT_DEFAULTS заданы', ROLLOUT_DEFAULTS.maxIdleDays === 14 && ROLLOUT_DEFAULTS.maxForeignDup === 0.9);
    }

    // SSE: читаем первые байты и закрываем соединение.
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
    const reader = sse.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    check('SSE /api/events отдает event-stream',
      String(sse.headers.get('content-type')).includes('text/event-stream'),
      String(sse.headers.get('content-type')));
    check('SSE присылает hello', chunk.includes('event: hello'), chunk.slice(0, 60));
    ac.abort();
  } finally {
    server.close();
  }

  // ── Демо-режим ───────────────────────────────────────────────────
  console.log('\n== Демо-режим ==');
  {
    const demoServer = await serve({ port: 0, demo: true });
    const dport = demoServer.address().port;
    try {
      const ds = await get(dport, '/api/state');
      check('Демо: GET /api/state — 200', ds.status === 200, `status=${ds.status}`);
      let dview = null;
      try { dview = JSON.parse(ds.text); } catch { /* ниже */ }
      if (dview) {
        check('Демо: view.projects заполнен из demo-state.json',
          Array.isArray(dview.projects) && dview.projects.length >= 5,
          `проектов=${dview.projects?.length}`);
        check('Демо: есть группы клонов', Array.isArray(dview.dupGroups) && dview.dupGroups.length >= 1);
        check('Демо: есть синтетические аренды',
          Array.isArray(dview.leases) && dview.leases.length >= 1,
          `аренд=${dview.leases?.length}`);
        const dp = dview.projects[0];
        check('Демо: контракт полей проекта цел',
          ['id', 'name', 'path', 'stage', 'score', 'stack', 'isGit', 'hasTests', 'loc', 'files',
            'staleDays', 'breakdown', 'dup', 'flags', 'value', 'valueSource', 'valueTier',
            'valuePriority', 'valueSignals'].every((k) => k in dp));
      }

      const dcu = await get(dport, '/api/cleanup');
      check('Демо: GET /api/cleanup — 200', dcu.status === 200);

      const dbr = await get(dport, '/api/brief');
      check('Демо: GET /api/brief — 200', dbr.status === 200);
      let dbrText = null;
      try { dbrText = JSON.parse(dbr.text).text; } catch { /* ниже */ }
      check('Демо: brief содержит текст', typeof dbrText === 'string' && dbrText.length > 0);

      const dConfigPost = await fetch(`http://127.0.0.1:${dport}/api/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leases: { ttlMinutes: 45 } }),
      });
      check('Демо: POST /api/config只读 (403)', dConfigPost.status === 403, `status=${dConfigPost.status}`);

      const dScan = await fetch(`http://127.0.0.1:${dport}/api/scan`, { method: 'POST' });
      check('Демо: POST /api/scan имитируется (202)', dScan.status === 202, `status=${dScan.status}`);

      const dReport = await fetch(`http://127.0.0.1:${dport}/api/report`, { method: 'POST' });
      check('Демо: POST /api/report отключён (403)', dReport.status === 403, `status=${dReport.status}`);
    } finally {
      demoServer.close();
    }
  }

  // ── Handoff (M4, Приоритет 2) ───────────────────────────────────
  console.log('\n== Handoff (M4, Приоритет 2) ==');
  {
    // Хранилище: append-only jsonl + резолв по id/path/имени (синтетика, не трогаем .vibe).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-handoff-'));
    const hfFile = path.join(tmp, 'handoffs.jsonl');
    const t0 = Date.now();

    const h1 = await appendHandoff({
      projectId: 'pa', projectPath: 'M:/a/proj-a', projectName: 'proj-a',
      owner: 'gamedesigner', note: 'сделал API заказов', summary: 'решил конфликт портов', files: ['src/order.js'],
      now: t0, filePath: hfFile,
    });
    check('handoff записывается', h1.owner === 'gamedesigner' && h1.note.includes('API'));

    const h2 = await appendHandoff({
      projectId: 'pa', projectPath: 'M:/a/proj-a', projectName: 'proj-a',
      owner: 'codex', note: 'добавил тесты', now: t0 + 1000, filePath: hfFile,
    });
    const latest = await latestHandoffForProject('pa', hfFile);
    check('latestHandoffForProject возвращает самую свежую', latest.owner === 'codex' && latest.note.includes('тесты'));

    const byName = await latestHandoffForTarget({ projectName: 'proj-a' }, hfFile);
    check('latestHandoffForTarget резолвит по имени', byName.owner === 'codex');
    const byPath = await latestHandoffForTarget({ projectPath: 'M:/a/proj-a' }, hfFile);
    check('latestHandoffForTarget резолвит по пути', byPath.owner === 'codex');

    check('latestHandoffForProject для неизвестного → null', (await latestHandoffForProject('unknown', hfFile)) === null);

    const all = await loadHandoffs(hfFile);
    check('loadHandoffs читает все записи', all.length === 2, `записей: ${all.length}`);

    let threw = false;
    try { await appendHandoff({ projectId: 'pa', owner: '', filePath: hfFile }); } catch { threw = true; }
    check('handoff без владельца отклоняется', threw);

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // CLI: запись и чтение пакета (пишет в реальный .vibe/handoffs.jsonl — как и делает агент).
  {
    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    console.error = () => {};
    try {
      const first = state.projects[0];
      await run(['handoff', first.name, '--owner', 'gamedesigner', '--note', 'smoke handoff']);
      check('vibe handoff записывает пакет', out.includes('Handoff записан') && out.includes('gamedesigner'));

      let out2 = '';
      console.log = (...a) => { out2 += a.join(' ') + '\n'; };
      await run(['handoff', 'read', first.name]);
      check('vibe handoff read выводит последний пакет', out2.includes('Последняя сессия') && out2.includes('gamedesigner'));

      // --limit N: несколько последних пакетов проекта (не только один).
      let out3 = '';
      console.log = (...a) => { out3 += a.join(' ') + '\n'; };
      await run(['handoff', 'read', first.name, '--limit', '3']);
      check('vibe handoff read --limit N выводит ленту пакетов',
        out3.includes('handoff-пакетов') && out3.includes('gamedesigner'));

      // --all: кросс-проектная лента — активность агентов во всём портфеле.
      let out4 = '';
      console.log = (...a) => { out4 += a.join(' ') + '\n'; };
      await run(['handoff', 'read', '--all', '--limit', '5']);
      check('vibe handoff read --all показывает все проекты',
        out4.includes('все проекты') && out4.includes('gamedesigner'));
    } catch (e) {
      check('vibe handoff CLI без ошибок', false, e.message);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  // CLI: `vibe brief`. Регресс: команда advertised в AGENTS.md (раскатывается по
  // проектам), но отсутствовала в карте COMMANDS — агенты получали «Неизвестная команда».
  {
    const origLog = console.log;
    let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    try {
      await run(['brief']);
      check('vibe brief выводит контекст сессии',
        out.includes('Контекст сессии') && out.includes('## Требуют решения'));
    } catch (e) {
      check('vibe brief без ошибок', false, e.message);
    } finally {
      console.log = origLog;
    }
  }

  // MCP-инструменты vibe_handoff_write / vibe_handoff_read + brief-блок.
  {
    const { handleMessage } = await import('../src/mcp.js');

    const wr = await handleMessage(JSON.stringify({
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'vibe_handoff_write', arguments: { project: state.projects[0].name, owner: 'codex', note: 'MCP handoff' } },
    }));
    check('vibe_handoff_write записывает пакет', wr.result?.content?.[0]?.text.includes('Handoff записан'));

    const rd = await handleMessage(JSON.stringify({
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'vibe_handoff_read', arguments: { project: state.projects[0].name } },
    }));
    check('vibe_handoff_read читает последний',
      rd.result?.content?.[0]?.text.includes('codex') || rd.result?.content?.[0]?.text.includes('Последняя сессия'));

    const list = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list' }));
    const names = (list.result?.tools || []).map((t) => t.name);
    check('tools/list содержит vibe_handoff_write', names.includes('vibe_handoff_write'));
    check('tools/list содержит vibe_handoff_read', names.includes('vibe_handoff_read'));
    check('tools/list теперь 12 инструментов', names.length === 12, String(names.length));

    // brief подтягивает handoff для проектов с флагами (через синтетический handoffs — не засоряем .vibe).
    const flaggedAll = state.projects.filter((p) => (p.flags || []).length);
    const syntheticHandoffs = flaggedAll.map((p) => ({
      projectId: p.id, projectPath: p.path, projectName: p.name, owner: 'codex', note: 'починил флаги', ts: new Date().toISOString(),
    }));
    const briefWithHf = await buildBriefText(state, [], { handoffs: syntheticHandoffs });
    check('brief содержит handoff-блок для проекта с флагами',
      !flaggedAll.length || (briefWithHf.includes('последний работал') && briefWithHf.includes('codex')));
  }

  console.log('\n== Итог ==');
  console.log(`  Пройдено: ${pass} · провалено: ${fail}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n smoke-тест упал: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
