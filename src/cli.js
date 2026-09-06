import path from 'node:path';
import fsSync from 'node:fs';
import fsPromises from 'node:fs/promises';
import { STAGE_LABEL } from './score.js';
import { formatAgo, formatBytes, formatNum } from './util.js';
import {
  PANEL_ROOT, REPORTS_DIR, defaultConfig, ensureVibeDir, loadConfig, requireConfig, saveConfig,
} from './config.js';
import { appendEvent, buildCleanupReport, loadState, refreshProjectState, saveState } from './store.js';
import { runScan } from './pipeline.js';
import {
  acquireLease, releaseLease, loadLeases, activeLeases, isExpired,
  readConflicts, countConflicts, recordConflict,
} from './leases.js';
import { writeReports } from './report.js';
import { serve, buildBriefText, buildLeasesView } from './serve.js';
import { watchProjects } from './watch.js';
import { pickRolloutTargets, ROLLOUT_DEFAULTS } from './rollout.js';
import { appendHandoff, latestHandoffForTarget, recentHandoffs } from './handoff.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
};

const STAGE_COLOR = { S0: C.red, S1: C.yellow, S2: C.yellow, S3: C.blue, S4: C.green, S5: C.green };
const STAGE_ORDER = { S0: 0, S1: 1, S2: 2, S3: 3, S4: 4, S5: 5 };

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) opts[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
      else opts[k] = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function table(rows, headers) {
  // Ширины считаются по «чистому» тексту: ANSI-коды не должны съезжать колонки.
  const clean = (s) => String(s ?? '').replace(ANSI_RE, '');
  const widths = headers.map((h, i) => Math.max(clean(h).length, ...rows.map((r) => clean(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i] + (String(c ?? '').length - clean(c).length))).join('  ').trimEnd();
  return [C.dim(line(headers)), C.dim(widths.map((w) => '-'.repeat(w)).join('  ')), ...rows.map(line)].join('\n');
}

/* ─────────────────────────── команды ─────────────────────────── */

async function cmdInit(opts) {
  const roots = opts.root
    ? [].concat(opts.root)
    : process.env.VIBE_ROOT
      ? [process.env.VIBE_ROOT]
      : [PANEL_ROOT];
  const cfg = { ...defaultConfig(), roots };
  await saveConfig(cfg);
  await ensureVibeDir();
  console.log(`${C.green('✓')} Панель инициализирована`);
  console.log(`  Корни сканирования: ${roots.map((r) => C.bold(r)).join(', ')}`);
  console.log(`  Конфиг: ${C.dim('.vibe/config.json')}`);
  console.log(`\nДальше: ${C.bold('vibe scan')}`);
}

async function cmdScan(opts) {
  const cfg = await requireConfig();
  const t0 = Date.now();
  let last = 0;

  const onProgress = (p) => {
    const now = Date.now();
    if (now - last < 200) return;
    last = now;
    if (p.phase === 'git') {
      process.stdout.write(`\r${C.dim('git: собираю состояние репозиториев…')}   `);
      return;
    }
    const what = p.phase === 'roots' ? 'поиск проектов' : p.phase === 'near' ? `почти-клоны: файлов ${p.files}` : 'сбор метрик';
    const extra = p.found !== undefined ? ` · найдено ${p.found}` : p.projects !== undefined ? ` · проектов ${p.projects}` : '';
    process.stdout.write(`\r${C.dim(`${what}: каталогов ${p.visited ?? 0}${extra}`)}   `);
  };

  const state = await runScan(cfg, onProgress);
  process.stdout.write('\r' + ' '.repeat(90) + '\r');

  const exactN = state.dupGroups.filter((g) => g.kind !== 'near').length;
  const nearN = state.dupGroups.length - exactN;
  console.log(`${C.green('✓')} Просканировано за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  console.log(`  Проектов: ${C.bold(state.projects.length)} · каталогов просмотрено: ${formatNum(state.scan.dirsVisited)}`);
  console.log(`  Групп клонов: ${C.bold(state.dupGroups.length)} · точных: ${exactN} · похожих (minhash ≥ ${Math.round(((cfg.dup || {}).nearThreshold ?? 0.85) * 100)}%): ${nearN}`);
  console.log(`  Состояние: ${C.dim('.vibe/state.json')}`);
  console.log(`\nДальше: ${C.bold('vibe list')} · ${C.bold('vibe report')} · ${C.bold('vibe watch')}`);

  if (opts.report) await cmdReport({});
}

async function cmdList(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');

  let projects = [...state.projects];
  const sort = opts.sort || 'priority';
  const sorters = {
    priority: (a, b) => b.priority - a.priority,
    score: (a, b) => a.score - b.score,
    stage: (a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9) || a.name.localeCompare(b.name, 'ru'),
    activity: (a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
    dup: (a, b) => (b.dupShare || 0) - (a.dupShare || 0),
    loc: (a, b) => b.loc - a.loc,
  };
  projects.sort(sorters[sort] || sorters.priority);

  if (opts.stage) projects = projects.filter((p) => p.stage.toLowerCase() === String(opts.stage).toLowerCase());
  if (opts.flag) projects = projects.filter((p) => p.flags.some((f) => f.code === opts.flag));
  const limit = Number(opts.limit) || 40;
  const shown = projects.slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify({
      generatedAt: state.generatedAt,
      sort,
      total: projects.length,
      projects: shown.map((p) => ({
        id: p.id, name: p.name, path: p.path, stage: p.stage, stageLabel: p.stageLabel,
        score: p.score, loc: p.loc, lastActivityAt: p.lastActivityAt,
        flags: p.flags.map((f) => f.code), dupShare: p.dupShare || 0, priority: p.priority,
      })),
    }, null, 2));
    return;
  }

  // Неуникальные имена путают: добавляем каталог, в котором лежит проект.
  const nameCounts = new Map();
  for (const p of state.projects) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);

  const rows = shown.map((p) => {
    const name = nameCounts.get(p.name) > 1
      ? `${p.name.slice(0, 24)} ${C.dim('@ ' + path.basename(path.dirname(p.path)))}`
      : p.name.slice(0, 34);
    return [
      (STAGE_COLOR[p.stage] || ((s) => s))(p.stage),
      String(p.score).padStart(3),
      name,
      formatNum(p.loc),
      formatAgo(p.lastActivityAt),
      p.flags.map((f) => f.label).join(', ').slice(0, 52) || C.dim('—'),
    ];
  });

  console.log(C.bold('\nЧто требует решения') + C.dim(` · сортировка: ${sort} · показано ${shown.length} из ${projects.length}`));
  console.log(table(rows, ['СТ', 'СКОР', 'ПРОЕКТ', 'LOC', 'АКТИВНОСТЬ', 'ПРОБЛЕМЫ']));
  console.log(C.dim(`\nПодсказка: ${'vibe show <имя>'} · ${'vibe list --sort score'} · ${'vibe list --flag stale'} · ${'vibe dup'}`));
}

async function cmdShow(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const q = String(opts._[0] || '').toLowerCase();
  if (!q) throw new Error('Укажите проект: vibe show <имя или id>');

  const p = state.projects.find((x) => x.id === q || x.name.toLowerCase() === q)
    || state.projects.find((x) => x.name.toLowerCase().includes(q));
  if (!p) throw new Error(`Проект не найден: ${q}`);

  if (opts.json) {
    console.log(JSON.stringify({
      ...p,
      dupGroups: state.dupGroups.filter((g) => g.members.some((m) => m.projectId === p.id)),
    }, null, 2));
    return;
  }

  const label = (s) => STAGE_LABEL[s];
  console.log(`\n${C.bold(p.name)}  ${(STAGE_COLOR[p.stage] || ((s) => s))(p.stage + ' ' + label(p.stage))}  ${C.bold(String(p.score))}/100`);
  console.log(C.dim(p.path));

  console.log(`\n${C.bold('Компоненты скора')}`);
  const names = {
    idea: 'Замысел зафиксирован',
    scaffold: 'Каркас',
    core: 'Ядро реализовано',
    tests: 'Тесты',
    config: 'Конфигурация',
    deploy: 'Запуск и деплой',
    docs: 'Документация',
  };
  const maxes = { idea: 10, scaffold: 20, core: 25, tests: 15, config: 10, deploy: 10, docs: 10 };
  for (const [k, v] of Object.entries(p.scoreParts)) {
    const bar = '#'.repeat(Math.round((v / maxes[k]) * 20)).padEnd(20, '.');
    console.log(`  ${names[k].padEnd(22)} ${bar} ${String(v).padStart(2)}/${maxes[k]}`);
  }
  if (p.scorePenalties?.length) {
    console.log(`  ${C.yellow('Штрафы').padEnd(22)} ${p.scorePenalties.map((x) => `${x.reason} (${x.value})`).join('; ')}`);
  }

  console.log(`\n${C.bold('Метрики')}`);
  console.log(`  Строк кода: ${formatNum(p.loc)} · файлов: ${formatNum(p.files)} · из них код: ${formatNum(p.codeFiles)} · тестов: ${p.testFiles}`);
  const langs = Object.entries(p.locByLang).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (langs.length) console.log(`  Языки: ${langs.map(([k, v]) => `${k} ${formatNum(v)}`).join(', ')}`);
  console.log(`  Активность: ${formatAgo(p.lastActivityAt)}`);
  console.log(`  Стек: ${p.stack.join(', ') || '—'}`);

  console.log(`\n${C.bold('Git')}`);
  if (p.git) {
    console.log(`  Ветка: ${p.git.branch || '—'} · remote: ${p.git.remote || C.yellow('нет')} · незакоммичено: ${p.git.uncommitted} · worktree: ${p.git.worktrees}`);
    if (p.git.lastCommitAt) console.log(`  Последний коммит: ${formatAgo(p.git.lastCommitAt)}`);
  } else {
    console.log(`  ${C.yellow('Не git-репозиторий')}`);
  }

  const mine = state.dupGroups.filter((g) => g.members.some((m) => m.projectId === p.id));
  console.log(`\n${C.bold('Дубликаты')}`);
  console.log(`  Участвует в группах клонов: ${mine.length} · дублированных строк: ${formatNum(p.dupLines)} (${Math.round((p.dupShare || 0) * 100)}%)`);
  for (const g of mine.slice(0, 5)) {
    const kindTag = g.kind === 'near' ? C.dim(` похожи ${Math.round((g.similarity ?? 1) * 100)}%`) : '';
    const others = g.members.filter((m) => m.projectId !== p.id);
    const self = g.members.find((m) => m.projectId === p.id);
    console.log(`  · ${C.dim(self.rel)} ${g.lines} стр.${kindTag}`);
    for (const o of others.slice(0, 4)) console.log(`      ${C.dim('↔')} ${path.basename(o.projectPath)}\\${o.rel}`);
    if (others.length > 4) console.log(`      ${C.dim(`… и ещё ${others.length - 4}`)}`);
  }

  if (p.flags.length) {
    console.log(`\n${C.bold('Проблемы')}`);
    for (const f of p.flags) console.log(`  · ${C.yellow(f.label)}`);
  }
  console.log('');
}

async function cmdDup(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const limit = Number(opts.limit) || 20;
  const kind = opts.kind ? String(opts.kind).toLowerCase() : null;
  let groups = opts.all ? state.dupGroups : state.dupGroups.filter((g) => g.crossProject);
  if (kind === 'exact' || kind === 'near') groups = groups.filter((g) => (g.kind === 'near' ? 'near' : 'exact') === kind);

  const kindsInState = state.dupGroups.reduce(
    (a, g) => { a[g.kind === 'near' ? 'near' : 'exact']++; return a; },
    { exact: 0, near: 0 },
  );
  const title = kind === 'exact' ? 'Точные клоны' : kind === 'near' ? 'Похожие файлы (minhash)' : 'Клоны';
  const scope = opts.all ? '' : ' (межпроектные)';

  if (opts.json) {
    console.log(JSON.stringify({
      kind: kind || 'all',
      all: !!opts.all,
      total: state.dupGroups.length,
      shown: groups.slice(0, limit).map((g) => ({
        id: g.id, kind: g.kind || 'exact', lines: g.lines, size: g.size,
        similarity: g.similarity ?? 1, drift: g.drift ?? 0,
        crossProject: g.crossProject, wastedBytes: g.wastedBytes || 0,
        members: g.members.map((m) => ({
          projectPath: m.projectPath, rel: m.rel, size: m.size, lines: m.lines,
          isCanonical: !!m.isCanonical,
        })),
      })),
    }, null, 2));
    return;
  }

  console.log(C.bold(`\n${title}${scope}`) + C.dim(` · в состоянии: точных ${kindsInState.exact}, похожих ${kindsInState.near} · показано ${Math.min(limit, groups.length)}`));

  groups.slice(0, limit).forEach((g, i) => {
    const isNear = g.kind === 'near';
    const sim = isNear ? C.dim(` · похожи на ${Math.round((g.similarity ?? 1) * 100)}%`) : '';
    console.log(`\n${C.bold(`${i + 1}.`)} ${g.lines} строк · ${g.members.length} копии${g.crossProject ? '' : C.dim(' (внутри проекта)')}${sim}`);
    for (const m of g.members.slice(0, 8)) {
      const memberSim = isNear && m.sim != null ? C.dim(` (${Math.round(m.sim * 100)}%)`) : '';
      console.log(`   ${C.dim(path.basename(m.projectPath) + '\\')}${m.rel}${memberSim}`);
    }
    if (g.members.length > 8) console.log(`   ${C.dim(`… и ещё ${g.members.length - 8}`)}`);
  });
  if (!groups.length) console.log(C.dim('\nНичего не найдено.'));
  console.log(C.dim('\nФильтр по виду: vibe dup --kind exact | --kind near'));
  console.log('');
}

async function cmdReport(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const dir = opts.out || REPORTS_DIR;
  const { mdPath, htmlPath } = await writeReports(state, { dir });
  console.log(`${C.green('✓')} Отчёты записаны:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${htmlPath}`);
}

async function cmdStats(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const counts = {};
  for (const p of state.projects) counts[p.stage] = (counts[p.stage] || 0) + 1;
  const totalLoc = state.projects.reduce((a, p) => a + (p.loc || 0), 0);
  const stale = state.projects.filter((p) => p.flags.some((f) => f.code === 'stale')).length;
  const nogit = state.projects.filter((p) => !p.git).length;

  if (opts.json) {
    const exactN = state.dupGroups.filter((g) => g.kind !== 'near').length;
    console.log(JSON.stringify({
      generatedAt: state.generatedAt,
      projects: state.projects.length,
      totalLoc,
      stages: counts,
      stale,
      nogit,
      dupGroups: {
        total: state.dupGroups.length,
        exact: exactN,
        near: state.dupGroups.length - exactN,
        crossProject: state.dupGroups.filter((g) => g.crossProject).length,
        wastedBytes: state.dupGroups.reduce((a, g) => a + (g.wastedBytes || 0), 0),
      },
    }, null, 2));
    return;
  }

  console.log(C.bold('\nСводка'));
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']) {
    const n = counts[s] || 0;
    const bar = '█'.repeat(Math.round((n / state.projects.length) * 30));
    console.log(`  ${(STAGE_COLOR[s] || ((x) => x))(s)} ${label(s).padEnd(9)} ${String(n).padStart(4)}  ${bar}`);
  }
  function label(s) { return STAGE_LABEL[s]; }
  console.log(`\n  Всего проектов: ${C.bold(state.projects.length)} · строк кода: ${C.bold(formatNum(totalLoc))}`);
  console.log(`  В застое (>60 дн.): ${C.yellow(stale)} · без git: ${C.yellow(nogit)}`);
  const exactN = state.dupGroups.filter((g) => g.kind !== 'near').length;
  const nearN = state.dupGroups.length - exactN;
  console.log(`  Групп клонов: ${C.bold(state.dupGroups.length)} · точных: ${exactN} · похожих: ${nearN} · межпроектных: ${C.bold(state.dupGroups.filter((g) => g.crossProject).length)}`);
  console.log('');
}

async function cmdServe(opts) {
  const port = Number(opts.port) || 5173;
  const demo = !!opts.demo;
  let server;
  try {
    server = await serve({ port, demo });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      throw new Error(`Порт ${port} занят. Укажите другой: vibe serve --port ${port + 1}`);
    }
    throw err;
  }
  if (demo) {
    console.log(`${C.yellow('◈')} Демо-режим: данные из ${C.bold('examples/demo-state.json')} (только просмотр)`);
  }
  console.log(`${C.green('✓')} Дашборд запущен: ${C.bold(`http://localhost:${port}`)}`);
  console.log(C.dim('  Обновите состояние в другой консоли: vibe scan — дашборд подхватит изменения.'));

  // Совмещённый режим: дашборд сам пересчитывает затронутые проекты на лету.
  let watch = null;
  if (opts.watch) {
    const cfg = await requireConfig();
    const state = await loadState();
    if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
    watch = await watchProjects({
      cfg,
      state,
      debounceMs: Number(opts.debounce) || 1200,
      onChange: (result, meta) => {
        void saveState(state);
        const files = meta.files.length ? ` · ${meta.files.slice(0, 3).join(', ')}${meta.files.length > 3 ? ` +${meta.files.length - 3}` : ''}` : '';
        const who = meta.owner ? ` [${meta.owner}]` : '';
        const diff = result.before.score !== result.after.score ? ` · скор ${result.before.score} → ${result.after.score}` : '';
        console.log(`${C.dim(new Date().toLocaleTimeString('ru-RU'))} ${C.green('↻')} ${result.project.name}${who}${diff}${files} · стадия ${result.after.stage}`);
      },
    });
    console.log(C.dim('  Режим watch включён: изменения файлов пересчитываются сами.'));
  }

  console.log(C.dim('  Остановка: Ctrl+C'));
  const stop = () => {
    if (watch) watch.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Псевдоним `vibe serve --demo`: поднять дашборд на вымышленных данных. */
async function cmdDemo(opts) {
  return cmdServe({ ...opts, demo: true });
}

export function findProjectEntry(state, q) {
  return state.projects.find((x) => x.id === q || x.name.toLowerCase() === q)
    || state.projects.find((x) => x.name.toLowerCase().includes(q));
}

/** Резолв аргумента проекта для аренд: имя/id из состояния или путь на диске. */
function resolveLeaseTarget(state, arg) {
  if (!arg) throw new Error('Укажите проект: vibe lease <проект> <файл|.> --owner <имя>');
  if (state) {
    const p = findProjectEntry(state, String(arg).toLowerCase());
    if (p) return { path: p.path, name: p.name };
  }
  if (fsSync.existsSync(arg)) return { path: arg, name: path.basename(arg) };
  throw new Error(`Проект не найден: ${arg}`);
}

function humanizeMs(ms) {
  if (ms <= 0) return 'истекла';
  const min = Math.floor(ms / 60000);
  if (min >= 60) return `${Math.floor(min / 60)} ч ${min % 60 ? `${min % 60} мин` : ''}`.trim();
  if (min >= 1) return `${min} мин`;
  return `${Math.max(1, Math.round(ms / 1000))} с`;
}

function leaseDisplay(lease) {
  return `${path.basename(lease.project)}\\${lease.rel}`;
}

async function cmdLease(opts) {
  const cfg = await requireConfig();
  const state = await loadState();
  const target = resolveLeaseTarget(state, opts._[0]);
  const rel = String(opts._[1] || '.');
  const owner = String(opts.owner || process.env.VIBE_AGENT || '').trim();
  if (!owner) {
    throw new Error('Укажите владельца: --owner <имя агента> (или переменная окружения VIBE_AGENT)');
  }
  const ttlMinutes = Number(opts.ttl ?? cfg.leases?.ttlMinutes ?? 30);
  const ttlMs = Math.max(5000, Math.round(ttlMinutes * 60000));

  const res = await acquireLease({
    project: target.path,
    rel,
    owner,
    ttlMs,
    reason: String(opts.reason || ''),
    force: !!opts.force,
  });

  if (!res.ok) {
    const holder = res.clashes[0];
    await appendEvent('lease.blocked', {
      project: target.name, rel, holder: holder.owner, requester: owner,
    });
    console.error(`${C.red('✗')} ${leaseDisplay(holder)} уже в аренде: ${C.bold(holder.owner)} (до ${new Date(holder.expiresAt).toLocaleTimeString('ru-RU')})`);
    console.error(C.dim('  Ждите освобождения или перехватите: --force (будет записан конфликт).'));
    process.exitCode = 1;
    return;
  }

  if (res.forced > 0) {
    await appendEvent('lease.forced', { project: target.name, rel, requester: owner });
  }
  await appendEvent('lease.acquired', {
    project: target.name, rel, owner, expiresAt: res.lease.expiresAt,
  });
  const left = humanizeMs(Date.parse(res.lease.expiresAt) - Date.now());
  console.log(`${C.green('✓')} Аренда: ${C.bold(leaseDisplay(res.lease))} → ${C.bold(owner)} · ${left} (до ${new Date(res.lease.expiresAt).toLocaleTimeString('ru-RU')})`);
  if (res.forced > 0) console.log(C.yellow(`  Перехвачена чужая аренда — конфликт записан: vibe conflicts`));
  if (res.pruned > 0) console.log(C.dim(`  Просроченных аренд снято: ${res.pruned}`));
  console.log(C.dim(`  Освободить: vibe release ${path.basename(target.path)} ${rel === '.' ? '.' : `"${rel}"`} --owner ${owner}`));
}

async function cmdRelease(opts) {
  const state = await loadState();
  const target = resolveLeaseTarget(state, opts._[0]);
  const rel = String(opts._[1] || '.');
  const owner = String(opts.owner || process.env.VIBE_AGENT || '').trim();
  if (!owner) throw new Error('Укажите владельца: --owner <имя агента>');

  const res = await releaseLease({ project: target.path, rel, owner });
  if (!res.ok) {
    if (res.reason === 'not-owner') {
      throw new Error(`Аренда ${leaseDisplay(res.lease)} принадлежит ${res.lease.owner}, а не ${owner}`);
    }
    throw new Error(`Аренда не найдена: ${path.basename(target.path)}\\${rel} (возможно, уже истекла по TTL)`);
  }
  await appendEvent('lease.released', { project: target.name, rel, owner });
  console.log(`${C.green('✓')} Аренда освобождена: ${C.bold(leaseDisplay(res.lease))} (${owner})`);
}

async function cmdLeases(opts) {
  const state = await loadState();
  const store = await loadLeases();
  const now = Date.now();
  const active = activeLeases(store, now);
  const expired = (store.leases || []).length - active.length;

  if (opts.json) {
    console.log(JSON.stringify({
      active: active.map((l) => ({
        id: l.id, project: l.project, rel: l.rel, owner: l.owner,
        reason: l.reason, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt,
        leftMs: Math.max(0, Date.parse(l.expiresAt) - now),
      })),
      expired,
    }, null, 2));
    return;
  }

  console.log(C.bold('\nАктивные аренды') + C.dim(` · всего: ${active.length}${expired ? ` · истёкших (будут сняты при следующем take): ${expired}` : ''}`));
  if (!active.length) {
    console.log(C.dim('  Свободно — никто ничего не держит.'));
    console.log(C.dim('\nВзять: vibe lease <проект> <файл|.> --owner <имя> [--ttl мин]'));
    console.log('');
    return;
  }
  const rows = active
    .map((l) => ({ ...l, left: Date.parse(l.expiresAt) - now }))
    .sort((a, b) => a.left - b.left)
    .map((l) => [
      leaseDisplay(l).slice(0, 52),
      l.owner,
      humanizeMs(l.left),
      l.rel === '.' ? C.blue('весь проект') : '',
      String(l.reason || '').slice(0, 40) || C.dim('—'),
    ]);
  console.log(table(rows, ['ФАЙЛ / ПРОЕКТ', 'ВЛАДЕЛЕЦ', 'ОСТАЛОСЬ', 'УРОВЕНЬ', 'ПРИЧИНА']));
  console.log(C.dim('\nОсвободить: vibe release <проект> <файл> --owner <имя>'));
  console.log('');
}

async function cmdConflicts(opts) {
  const limit = Number(opts.limit) || 20;
  const total = await countConflicts();
  const items = await readConflicts(limit);

  if (opts.json) {
    console.log(JSON.stringify({ total, shown: items }, null, 2));
    return;
  }

  console.log(C.bold('\nКонфликты аренд') + C.dim(` · всего: ${total} · показано ${Math.min(limit, items.length)}`));
  if (!items.length) {
    console.log(C.dim('  Конфликтов не было.'));
    console.log('');
    return;
  }
  for (const c of items) {
    const ts = new Date(c.ts).toLocaleString('ru-RU');
    const who = [c.holder && `держал ${C.bold(c.holder)}`, c.requester && `просил ${C.bold(c.requester)}`]
      .filter(Boolean).join(', ');
    console.log(`  ${C.dim(ts)} ${c.type === 'forced' ? C.yellow('перехват') : C.red('блокировка')} · ${path.basename(c.project)}\\${c.rel} · ${who}${c.note ? C.dim(` · ${c.note}`) : ''}`);
  }
  console.log('');
}

async function cmdHandoff(opts) {
  const sub = String(opts._[0] || '').toLowerCase();
  if (sub === 'read') return cmdHandoffRead(opts);

  const state = await loadState();
  const q = sub;
  if (!q) {
    throw new Error('Укажите проект: vibe handoff <имя|id|путь> --owner <ты> [--note ".."] [--summary ".."] [--files f1,f2]');
  }

  let target;
  if (state) {
    const p = findProjectEntry(state, q);
    if (p) target = { projectId: p.id, projectPath: p.path, projectName: p.name };
  }
  if (!target) {
    if (fsSync.existsSync(q)) {
      target = { projectId: null, projectPath: q, projectName: path.basename(q) };
    } else {
      throw new Error(`Проект не найден: ${q}`);
    }
  }

  const owner = String(opts.owner || process.env.VIBE_AGENT || '').trim();
  if (!owner) {
    throw new Error('Укажите владельца: --owner <имя агента> (или переменная окружения VIBE_AGENT)');
  }

  const note = String(opts.note || '').trim();
  const summary = String(opts.summary || '').trim();
  const files = opts.files
    ? String(opts.files).split(/[,\s]+/).filter(Boolean)
    : opts._.slice(1);

  const entry = await appendHandoff({
    projectId: target.projectId,
    projectPath: target.projectPath,
    projectName: target.projectName,
    owner, note, summary, files,
  });
  await appendEvent('handoff.written', {
    project: target.projectName,
    owner,
    note: note ? note.slice(0, 80) : '',
    files: files.length,
  });

  console.log(`${C.green('✓')} Handoff записан: ${C.bold(target.projectName)} ← ${C.bold(owner)} · ${formatAgo(entry.ts)}`);
  if (note) console.log(`  ${C.dim(note)}`);
  if (summary) console.log(`  ${C.dim(summary)}`);
  if (files.length) console.log(C.dim(`  файлы: ${files.join(', ')}`));
  console.log(C.dim('  Следующий агент прочитает это через vibe brief или vibe handoff read <проект>.'));
}

/** Лента handoff-пакетов: новые сверху. */
function printHandoffList(items, title) {
  console.log(C.bold(title));
  for (const h of items) {
    const proj = h.projectName || h.projectPath || '—';
    console.log(`  ${C.dim(formatAgo(h.ts))} · ${C.bold(proj)} ← ${C.bold(h.owner)}`);
    if (h.note) console.log(`      ${h.note}`);
  }
}

async function cmdHandoffRead(opts) {
  const state = await loadState();
  const q = String(opts._[1] || '').toLowerCase();
  const wantAll = Boolean(opts.all ?? opts.a);
  const limitRaw = Number(opts.limit ?? opts.n) || 0;

  // Кросс-проектный режим: видна активность агентов во всём портфеле.
  if (wantAll) {
    const items = await recentHandoffs(null, { limit: limitRaw > 0 ? limitRaw : 20 });
    if (!items.length) {
      console.log(C.dim('Handoff-журнал пуст — агенты ещё не передавали контекст.'));
      return;
    }
    printHandoffList(items, `\nПоследние handoff-пакеты (все проекты): ${items.length}`);
    return;
  }

  if (!q) throw new Error('Укажите проект: vibe handoff read <имя|id|путь> (или --all для всех проектов)');

  let target;
  if (state) {
    const p = findProjectEntry(state, q);
    if (p) target = { projectId: p.id, projectPath: p.path, projectName: p.name };
  }
  if (!target && fsSync.existsSync(q)) {
    target = { projectId: null, projectPath: q, projectName: path.basename(q) };
  }
  if (!target) throw new Error(`Проект не найден: ${q}`);

  // Несколько последних пакетов проекта.
  if (limitRaw > 1) {
    const items = await recentHandoffs(target, { limit: limitRaw });
    if (!items.length) {
      console.log(`${C.dim('Handoff для')} ${C.bold(target.projectName)} ${C.dim('ещё не записан — агенты не передавали контекст.')}`);
      return;
    }
    printHandoffList(items, `\nПоследние ${items.length} handoff-пакетов · ${target.projectName}`);
    return;
  }

  const h = await latestHandoffForTarget(target);
  if (!h) {
    console.log(`${C.dim('Handoff для')} ${C.bold(target.projectName)} ${C.dim('ещё не записан — агенты не передавали контекст.')}`);
    return;
  }
  console.log(C.bold(`\nПоследняя сессия · ${target.projectName}`));
  console.log(`${C.dim('кто:')} ${h.owner} · ${formatAgo(h.ts)}`);
  if (h.note) console.log(`${C.dim('что сделал:')} ${h.note}`);
  if (h.summary) console.log(`${C.dim('подробнее:')} ${h.summary}`);
  if (h.files && h.files.length) console.log(`${C.dim('файлы:')} ${h.files.join(', ')}`);
}

/**
 * `vibe brief` — готовая сводка для старта сессии.
 * Тот же текст, что отдаёт MCP-инструмент `vibe_brief` и кнопка «Контекст
 * для новой сессии» на дашборде: агент из консоли должен получить его без
 * запущенного сервера и без MCP-клиента.
 */
async function cmdBrief() {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const leases = await buildLeasesView();
  console.log(await buildBriefText(state, leases));
}

const LEASES_MARKER_START = '<!-- vibe:leases:start -->';
const LEASES_MARKER_END = '<!-- vibe:leases:end -->';

/**
 * Файлы инструкций агентов. Один файл не покрывает всех:
 * Codex/OpenCode/ZCode читают AGENTS.md, Claude Code — только CLAUDE.md,
 * а Gemini/Antigravity (Google, Gemini) — только GEMINI.md.
 * Поэтому пишем AGENTS.md как источник истины, а CLAUDE.md и GEMINI.md
 * держим тонкими прокладками с импортом. Симлинк не годится: на Windows
 * он требует прав администратора или режима разработчика.
 */
const AGENTS_FILE = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';
const CLAUDE_IMPORT_LINE = '@AGENTS.md';
const GEMINI_FILE = 'GEMINI.md';
const GEMINI_IMPORT_LINE = '@AGENTS.md';

function leasesRulesBlock(panelRoot, projectName) {
  const cliFull = `node "${panelRoot.replace(/\\/g, '/')}/bin/vibe.js"`;
  const scope = projectName ? `проекта \`${projectName}\`` : 'этого дерева проектов';
  return `${LEASES_MARKER_START}
## Аренды файлов (панель вайбкодинга)

Прежде чем править файлы ${scope}, возьми короткую аренду — чтобы два агента
не перетирали один файл. Панель работает локально, без сети.

Коротко (если каталог панели в PATH):
\`\`\`
vibe leases                                  кто что держит сейчас
vibe lease <проект> <файл|.> --owner <ты>   взять (TTL 30 мин; --ttl N свой)
vibe release <проект> <файл> --owner <ты>   освободить после правки
\`\`\`

Если \`vibe\` не нашёлся — запускай полностью: \`${cliFull} <команда>\`.

Просроченная аренда (30 мин) освобождается сама. Запись в файл под чужой
арендой — конфликт (блокирует следующий \`lease\` и пишется в журнал). Перехват
чужой аренды (\`--force\`) тоже фиксируется как конфликт. Журнал: \`vibe conflicts\`.

**Пиши только в свои файлы.** Панель видит запись под чужой арендой: если ты
правишь файл, который держит другой агент, это попадает в ленту дашборда как
«запись под чужой арендой» и в журнал конфликтов (\`vibe conflicts\`) — с твоим
именем. Если файл нужен тебе — договорись через \`vibe handoff\` или бери аренду
после освобождения, а не перетирай правки молча.

Возобновление работы. Перед стартом получи контекст одной командой:
\`vibe brief\` (или кнопка «Контекст для новой сессии» на дашборде) — сводка
портфеля, что требует решения, кто держит аренды. Каноническая точка возобновления
и раздел «Следующий шаг» — \`PROGRESS.md\` в каталоге панели: читай его первым.

Передача контекста следующему агенту (handoff). Когда закончил — оставь пакет,
чтобы следующий не начинал с нуля:
\`\`\`
vibe handoff <проект> --owner <ты> --note "что сделал, что осталось"
vibe handoff read <проект>   кто работал передо мной и что делал
vibe handoff read --all      кросс-проектная лента: что делали агенты во всех
                             проектах (вручную читать .vibe/handoffs.jsonl не нужно)
\`\`\`

Если панель зарегистрирована как MCP-сервер (в \`mcp.json\` → \`vibe\`), те же
данные доступны инструментами: \`vibe_status\`, \`vibe_project\`, \`vibe_leases\`,
\`vibe_lease_take\`, \`vibe_lease_release\`, \`vibe_dups\`, \`vibe_cleanup\`,
\`vibe_brief\`, \`vibe_refresh\`, \`vibe_handoff_write\`, \`vibe_handoff_read\`.
${LEASES_MARKER_END}`;
}

/**
 * Тонкая прокладка: пишет/дополняет <file> строкой импорта <importLine>,
 * не затирая существующее содержимое. Идемпотентна — повторный запуск
 * не дублирует строку импорта. Возвращает путь к файлу.
 */
async function writeShim(dir, file, importLine) {
  const shimPath = path.join(dir, file);
  let shim = '';
  try {
    shim = await fsPromises.readFile(shimPath, 'utf8');
  } catch { /* файла нет — создадим */ }
  if (!shim.split(/\r?\n/).some((l) => l.trim() === importLine)) {
    shim = shim.trim()
      ? `${shim.trimEnd()}\n\n${importLine}\n`
      : `# ${file}\n\n${importLine}\n`;
    await fsPromises.writeFile(shimPath, shim, 'utf8');
  }
  return shimPath;
}

/**
 * Пишет правила аренд в каталог проекта: AGENTS.md (источник истины) и,
 * если не отключено, прокладки CLAUDE.md (Claude Code) и GEMINI.md
 * (Gemini/Antigravity). Повторный вызов не дублирует блоки.
 *
 * @returns {Promise<{agentsPath: string, shimPath: string|null, geminiPath: string|null}>}
 */
export async function writeAgentRules(dir, panelRoot, projectName = null, { withShim = true, withGemini = true } = {}) {
  const block = leasesRulesBlock(panelRoot, projectName);

  const agentsPath = path.join(dir, AGENTS_FILE);
  let content = '';
  try {
    content = await fsPromises.readFile(agentsPath, 'utf8');
  } catch { /* файла нет — создадим */ }

  if (content.includes(LEASES_MARKER_START) && content.includes(LEASES_MARKER_END)) {
    const re = new RegExp(`${LEASES_MARKER_START}[\\s\\S]*?${LEASES_MARKER_END}`);
    content = content.replace(re, block);
  } else if (content) {
    content = `${content.trimEnd()}\n\n${block}\n`;
  } else {
    content = `# ${AGENTS_FILE}\n\n${block}\n`;
  }
  await fsPromises.writeFile(agentsPath, content, 'utf8');

  let shimPath = null;
  if (withShim) shimPath = await writeShim(dir, CLAUDE_FILE, CLAUDE_IMPORT_LINE);
  let geminiPath = null;
  if (withGemini) geminiPath = await writeShim(dir, GEMINI_FILE, GEMINI_IMPORT_LINE);

  return { agentsPath, shimPath, geminiPath };
}

/**
 * Массовая раскатка: правила во все рабочие проекты разом.
 * Отбор — `pickRolloutTargets()` (см. src/rollout.js): без бэкапов, копий,
 * застаревших, клонов и вложенных проектов.
 */
async function cmdAgentsMdRollout(cfg, opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');

  const dryRun = Boolean(opts['dry-run'] ?? opts.dryRun);
  const withShim = !(opts['no-shim'] ?? opts.noShim);
  const withGemini = !(opts['no-gemini'] ?? opts.noGemini);
  const maxIdleDays = Number(opts['max-idle'] ?? opts.maxIdle) || ROLLOUT_DEFAULTS.maxIdleDays;

  const { targets, rejected } = pickRolloutTargets(state.projects, {
    maxIdleDays,
    roots: cfg.roots,
    dupGroups: state.dupGroups,
  });

  console.log(C.bold(`Рабочие проекты: ${targets.length}`) + C.dim(` (активность ≤ ${maxIdleDays} дн., без копий и клонов)`));
  if (!targets.length) {
    console.log(C.dim('Нечего раскатывать. Проверьте порог --max-idle.'));
    return;
  }

  if (dryRun) {
    for (const t of targets) {
      const ago = t.idleDays === null ? '—' : (t.idleDays === 0 ? 'сегодня' : `${t.idleDays} дн.`);
      console.log(`  ${C.dim('будет:')} ${t.project.name.padEnd(34)} ${C.dim(ago.padStart(9))}  ${t.project.path}`);
    }
  } else {
    for (const t of targets) {
      try {
        await writeAgentRules(t.project.path, PANEL_ROOT, t.project.name, { withShim, withGemini });
        console.log(`  ${C.green('✓')} ${t.project.name.padEnd(34)} ${C.dim(t.project.path)}`);
      } catch (err) {
        console.log(`  ${C.dim('пропущено:')} ${t.project.name.padEnd(34)} ${C.dim(`${t.project.path} — ${err.code || err.message}`)}`);
      }
    }
    await appendEvent('agents-md.rollout', { projects: targets.length });
  }

  console.log(`\n${C.bold('Пропущено:')} ${rejected.length}`);
  for (const r of rejected) {
    console.log(`  ${C.dim('·')} ${String(r.name).padEnd(34)} ${C.dim(r.reason)}`);
  }
  if (!dryRun) {
    console.log(C.dim('\nПравила не дублируются: повторный запуск заменяет блок между маркерами.'));
  }
}

async function cmdAgentsMd(opts) {
  const cfg = await requireConfig();

  if (opts.active) {
    await cmdAgentsMdRollout(cfg, opts);
    return;
  }

  let dir;
  let projectName = null;
  if (opts.project) {
    const state = await loadState();
    const target = resolveLeaseTarget(state, opts.project);
    dir = target.path;
    projectName = target.name;
  } else {
    dir = cfg.roots[0];
  }

  const withShim = !(opts['no-shim'] ?? opts.noShim);
  const withGemini = !(opts['no-gemini'] ?? opts.noGemini);
  const { agentsPath, shimPath, geminiPath } = await writeAgentRules(dir, PANEL_ROOT, projectName, { withShim, withGemini });
  await appendEvent('agents-md.updated', { file: agentsPath });

  console.log(`${C.green('✓')} Правила аренд записаны в ${C.bold(agentsPath)}`);
  if (shimPath) {
    console.log(`${C.green('✓')} Прокладка для Claude Code: ${C.bold(shimPath)} → @AGENTS.md`);
    console.log(C.dim('  Codex и OpenCode читают AGENTS.md; Claude Code — только CLAUDE.md,'));
    console.log(C.dim('  поэтому держим оба файла: один источник истины, второй импортирует его.'));
  } else {
    console.log(C.dim('  Прокладка CLAUDE.md не создана (--no-shim).'));
  }
  if (geminiPath) {
    console.log(`${C.green('✓')} Прокладка для Gemini/Antigravity: ${C.bold(geminiPath)} → @AGENTS.md`);
    console.log(C.dim('  Antigravity (Google, Gemini) и Gemini CLI читают GEMINI.md,'));
    console.log(C.dim('  поэтому та же прокладка в формате GEMINI.md.'));
  } else {
    console.log(C.dim('  Прокладка GEMINI.md не создана (--no-gemini).'));
  }
}

async function cmdRefresh(opts) {
  const cfg = await requireConfig();
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');
  const q = String(opts._[0] || '').toLowerCase();
  if (!q) throw new Error('Укажите проект: vibe refresh <имя или id>');
  const p = findProjectEntry(state, q);
  if (!p) throw new Error(`Проект не найден: ${q}`);

  const t0 = Date.now();
  const result = await refreshProjectState(state, p.path, cfg);
  if (!result) throw new Error(`Проект исчез с диска: ${p.path}`);
  await saveState(state);
  await appendEvent('project.refreshed', {
    project: result.project.name,
    score: result.project.score,
    scoreBefore: result.before.score,
    stage: result.project.stage,
  });

  const arrow = result.before.score !== result.after.score
    ? ` ${C.dim('→')} ${C.bold(String(result.after.score))}`
    : ` ${C.dim('(без изменений)')}`;
  console.log(`${C.green('✓')} ${C.bold(result.project.name)} пересчитан за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  console.log(`  Скор: ${result.before.score}${arrow} · стадия: ${result.after.stage} · строк: ${formatNum(result.project.loc)}`);
  console.log(C.dim('  Точные и near-группы с участием проекта пересобраны (near — по кэшу подписей).'));
}

async function cmdCleanup(opts) {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');

  const kind = String(opts.kind || 'exact').toLowerCase() === 'near' ? 'near' : 'exact';
  const minBytes = Number(opts['min-bytes'] ?? opts.minBytes ?? 0) || 0;
  const limit = Number(opts.limit) || 20;
  const report = buildCleanupReport(state, { kind, minBytes });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const kindLabel = kind === 'near' ? 'почти-клоны (minhash)' : 'точные клоны';
  console.log(C.bold(`\nКандидаты на удаление · ${kindLabel}`) + C.dim(` · групп: ${report.groups}`));
  console.log(`  Можно освободить: ${C.bold(formatBytes(report.totalBytes))} · файлов: ${formatNum(report.totalFiles)} · строк: ${formatNum(report.totalLines)}`);
  if (!report.totalFiles) {
    console.log(C.dim('\n  Нечего освобождать — неканонических копий нет.'));
    console.log('');
    return;
  }

  if (report.noCanonicalProjects.length && kind === 'exact') {
    console.log(`\n${C.bold('Целиком неуникальные проекты')} ${C.dim('(ни одна их копия не является каноном)')}`);
    for (const r of report.noCanonicalProjects.slice(0, limit)) {
      console.log(`  · ${C.red(r.name)} — ${formatBytes(r.wastedBytes)} в ${formatNum(r.files)} файлах`);
    }
    if (report.noCanonicalProjects.length > limit) {
      console.log(C.dim(`  … и ещё ${report.noCanonicalProjects.length - limit}`));
    }
  }

  console.log(`\n${C.bold('По проектам')} ${C.dim(`· топ ${Math.min(limit, report.projects.length)} из ${report.projects.length}`)}`);
  const rows = report.projects.slice(0, limit).map((r) => [
    r.name.slice(0, 36),
    formatBytes(r.wastedBytes),
    formatNum(r.files),
    formatNum(r.wastedLines),
    report.noCanonicalProjects.includes(r) ? C.red('целиком') : C.dim('частично'),
  ]);
  console.log(table(rows, ['ПРОЕКТ', 'ОСВОБОДИТСЯ', 'ФАЙЛОВ', 'СТРОК', 'РЕШЕНИЕ']));

  const shownGroups = state.dupGroups
    .filter((g) => (g.kind === 'near' ? 'near' : 'exact') === kind && g.wastedBytes > 0 && (g.wastedBytes || 0) >= minBytes)
    .sort((a, b) => b.wastedBytes - a.wastedBytes)
    .slice(0, limit);
  console.log(`\n${C.bold('Топ групп')}`);
  shownGroups.forEach((g, i) => {
    const canon = g.members.find((m) => m.isCanonical);
    console.log(`  ${C.bold(`${i + 1}.`)} ${g.lines} строк · ${g.members.length} копии — ${formatBytes(g.wastedBytes)} ${C.dim(g.crossProject ? '· межпроектная' : '· внутри проекта')}`);
    if (canon) console.log(`     ${C.dim('канон:')} ${path.basename(canon.projectPath)}\\${canon.rel}`);
    for (const m of g.members.filter((m) => !m.isCanonical).slice(0, 4)) {
      console.log(`     ${C.dim('копия:')} ${path.basename(m.projectPath)}\\${m.rel}`);
    }
    const rest = g.members.filter((m) => !m.isCanonical).length - 4;
    if (rest > 0) console.log(`     ${C.dim(`… и ещё ${rest}`)}`);
  });

  if (kind === 'exact' && report.nearWastedBytes > 0) {
    console.log(C.dim(`\nПлюс почти-дубли на ${formatBytes(report.nearWastedBytes)} — удалять только после сверки: vibe cleanup --kind near`));
  }
  console.log(C.dim('\nЭто отчёт: панель ничего не удаляет сама.'));
  console.log('');
}

async function cmdWatch(opts) {
  const cfg = await requireConfig();
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: vibe scan');

  const debounceMs = Number(opts.debounce) || 1200;
  const handle = await watchProjects({
    cfg,
    state,
    debounceMs,
    onChange: (result, meta) => {
      // Пишем состояние сразу: дашборд (vibe serve) подхватит через SSE.
      // Событие project.activity в журнал кладёт сам watchProjects.
      void saveState(state);
      const files = meta.files.length ? ` · ${meta.files.slice(0, 3).join(', ')}${meta.files.length > 3 ? ` +${meta.files.length - 3}` : ''}` : '';
      const who = meta.owner ? ` [${meta.owner}]` : '';
      const diff = result.before.score !== result.after.score ? ` · скор ${result.before.score} → ${result.after.score}` : '';
      console.log(`${C.dim(new Date().toLocaleTimeString('ru-RU'))} ${C.green('↻')} ${result.project.name}${who}${diff}${files} · стадия ${result.after.stage}`);
    },
  });

  console.log(`${C.green('✓')} Слежу за изменениями (дебаунс ${debounceMs} мс):`);
  for (const root of cfg.roots) console.log(`  ${C.dim('·')} ${root}`);
  console.log(C.dim('  Изменённые проекты пересчитываются на лету и пишутся в .vibe/state.json.'));
  console.log(C.dim('  Дашборд (vibe serve) подхватит обновления автоматически. Остановка: Ctrl+C'));

  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    handle.close();
    void saveState(state).then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function cmdHelp() {
  console.log(`
${C.bold('vibe')} — панель управления вайбкодингом (инвентаризация + дубли + live-дашборд)

${C.bold('Команды')}
  vibe init [--root <путь>]     создать конфиг (по умолчанию корень — папка панели, либо переменная VIBE_ROOT)
  vibe scan [--report]          просканировать все корни, собрать метрики, git и дубликаты
  vibe stats                    сводка по стадиям
  vibe list                     список «что требует решения»
      --sort priority|score|stage|activity|name|dup|loc
      --stage S0..S5  --flag stale|nogit|dups|notests|orphan  --limit N
  vibe show <имя|id>            карточка проекта: скор, метрики, git, дубли
  vibe dup [--all] [--limit N]  группы клонов: точные и похожие
      --kind exact|near
  vibe cleanup [--kind exact|near] [--min-bytes N] [--limit N] [--json]
                                кандидаты на удаление и сколько освободится
  vibe refresh <имя|id>         пересчитать один проект без полного скана
  vibe watch                    следить за файлами и пересчитывать проекты на лету
  vibe lease <проект> <файл|.>  взять аренду на файл (или проект целиком)
      --owner <имя>  [--ttl мин]  [--reason S]  [--force]
  vibe release <проект> <файл>  освободить аренду (--owner обязателен)
  vibe leases                   активные аренды с обратным отсчётом
  vibe conflicts                журнал конфликтов аренд
  vibe handoff <проект> --owner <ты> [--note S] [--summary S] [--files f1,f2]
                                записать контекст сессии (что сделал агент)
  vibe handoff read <проект>   показать последний handoff проекта
      --limit N                показать N последних пакетов проекта
  vibe handoff read --all [--limit N]
                                кросс-проектная лента: что делали агенты во всех проектах
  vibe brief                   готовая сводка для старта сессии (то же, что vibe_brief и
                                кнопка «Контекст для новой сессии» на дашборде)
  vibe agents-md [--project X] [--no-shim] [--no-gemini]
                                вписать правила аренд: AGENTS.md (истина) + CLAUDE.md
                                с импортом @AGENTS.md (для Claude Code)
  vibe agents-md --active [--dry-run] [--max-idle N]
                                раскатать правила по всем рабочим проектам
                                (без бэкапов, копий, клонов и вложенных)
  vibe report [--out <dir>]     Markdown + HTML отчёт
  vibe serve [--port N]         живой веб-дашборд (по умолчанию порт 5173)
  vibe demo [--port N]          дашборд на вымышленных данных (examples/demo-state.json)

${C.bold('Примеры')}
  vibe init --root "<YOUR_PROJECTS_DIR>"
  vibe scan --report
  vibe list --flag stale --limit 20
  vibe list --sort stage
  vibe show sl-parser
  vibe refresh sl-parser
  vibe demo                    # показать дашборд на демо-данных без сканирования
`);
}

const COMMANDS = {
  init: cmdInit, scan: cmdScan, list: cmdList, show: cmdShow,
  dup: cmdDup, cleanup: cmdCleanup, report: cmdReport, stats: cmdStats, serve: cmdServe,
  demo: cmdDemo, refresh: cmdRefresh, watch: cmdWatch, help: cmdHelp,
  lease: cmdLease, release: cmdRelease, leases: cmdLeases,
  conflicts: cmdConflicts, 'agents-md': cmdAgentsMd,
  handoff: cmdHandoff, brief: cmdBrief,
};

export async function run(argv) {
  const opts = parseArgs(argv);
  const cmd = String(opts._[0] || 'help').toLowerCase();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`Неизвестная команда: ${cmd}`);
    cmdHelp();
    return;
  }
  if (opts.help || opts.h) { cmdHelp(); return; }
  await fn({ ...opts, _: opts._.slice(1) });
}
