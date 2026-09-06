/**
 * MCP-сервер панели (M4, минимум). stdio-транспорт, JSON-RPC 2.0, ноль зависимостей.
 *
 * Зачем: агент должен поднимать контекст проекта за один вызов, а не гадать,
 * какие файлы трогать. Всё состояние читается с диска — запущенный `vibe serve`
 * не требуется, сервер можно поднимать в любой сессии любого агента.
 *
 * Правило транспорта: stdout — только протокол. Все логи и диагностика — в stderr,
 * иначе клиент не разберёт ответ.
 */

import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, formatNum, formatAgo, daysSince } from './util.js';
import { requireConfig } from './config.js';
import { loadState, saveState, appendEvent, refreshProjectState } from './store.js';
import { loadLeases, activeLeases, acquireLease, releaseLease } from './leases.js';
import { buildCleanupView, buildBriefText, buildLeasesView } from './serve.js';
import { findProjectEntry } from './cli.js';
import { appendHandoff, latestHandoffForTarget } from './handoff.js';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'vibe-panel', version: '0.5.0' };
const DEFAULT_TTL_MINUTES = 30;

// ─────────────────────────────── Форматирование

function stageTally(projects) {
  const tally = {};
  for (const p of projects) tally[p.stage] = (tally[p.stage] || 0) + 1;
  return ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']
    .filter((s) => tally[s])
    .map((s) => `${s} ${tally[s]}`)
    .join(' · ');
}

function dupTally(groups) {
  const exact = groups.filter((g) => g.kind === 'exact').length;
  return { total: groups.length, exact, near: groups.length - exact };
}

function leaseLine(lease, now) {
  const leftMin = Math.max(0, Math.round((Date.parse(lease.expiresAt) - now) / 60000));
  const why = lease.reason ? ` — ${lease.reason}` : '';
  return `· ${lease.project} / ${lease.rel} — ${lease.owner} (${leftMin} мин)${why}`;
}

async function getState() {
  const state = await loadState();
  if (!state) throw new Error('Состояние отсутствует. Выполните: node bin/vibe.js scan');
  return state;
}

// ─────────────────────────────── Инструменты

async function toolStatus() {
  const state = await getState();
  const dups = dupTally(state.dupGroups || []);
  const leases = activeLeases(await loadLeases());
  const stale = state.projects.filter((p) => (daysSince(p.lastActivityAt) ?? 0) > 60).length;
  return [
    `Проектов: ${state.projects.length} · скан: ${formatAgo(state.generatedAt)}`,
    `Стадии: ${stageTally(state.projects)}`,
    `Клоны: ${dups.total} групп (${dups.exact} точных, ${dups.near} похожих) · застойных: ${stale}`,
    `Аренды: ${leases.length} активных`,
    `Требуют решения: ${state.projects.filter((p) => (p.flags || []).length).length}`,
  ].join('\n');
}

async function toolProjects(args) {
  const state = await getState();
  const limit = clampInt(args.limit, 20, 1, 100);
  const stage = args.stage ? String(args.stage).toUpperCase() : null;
  const flag = args.flag ? String(args.flag).toLowerCase() : null;
  const sort = String(args.sort || 'priority').toLowerCase();

  let rows = state.projects.slice();
  if (stage) rows = rows.filter((p) => p.stage === stage);
  if (flag) rows = rows.filter((p) => (p.flags || []).some((f) => codeOf(f) === flag));

  const cmp = {
    priority: (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    score: (a, b) => (a.score ?? 0) - (b.score ?? 0),
    activity: (a, b) => Date.parse(b.lastActivityAt || 0) - Date.parse(a.lastActivityAt || 0),
    name: (a, b) => String(a.name).localeCompare(String(b.name), 'ru'),
  }[sort] || ((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  rows = rows.sort(cmp).slice(0, limit);
  if (!rows.length) return 'Проектов по фильтру нет.';

  const lines = rows.map((p) => {
    const flags = (p.flags || []).map((f) => codeOf(f)).join(',');
    return `${p.stage} ${String(p.score).padStart(3)}  ${p.name.padEnd(34)} ${formatNum(p.loc).padStart(7)} строк  ${formatAgo(p.lastActivityAt).padStart(14)}${flags ? `  [${flags}]` : ''}`;
  });
  return `Показано ${rows.length} из ${state.projects.length}\n${lines.join('\n')}`;
}

async function toolProject(args) {
  const state = await getState();
  const q = String(args.name || '').trim();
  if (!q) throw new Error('Укажите проект: { "name": "salebot" }');
  const p = findProjectEntry(state, q.toLowerCase());
  if (!p) throw new Error(`Проект не найден: ${q}`);

  const parts = Object.entries(p.scoreParts || {}).map(([k, v]) => `${k} ${v}`).join(', ');
  const flags = (p.flags || []).map((f) => codeOf(f)).join(', ') || 'нет';
  const dups = (state.dupGroups || [])
    .filter((g) => (g.members || []).some((m) => m.projectId === p.id))
    .sort((a, b) => (b.wastedBytes || 0) - (a.wastedBytes || 0))
    .slice(0, 3);

  const lines = [
    `${p.name} — ${p.stage} (${p.stageLabel || ''}), скор ${p.score}`,
    `Путь: ${p.path}`,
    `Стек: ${(p.stack || []).join(', ') || '—'} · строк: ${formatNum(p.loc)} · файлов: ${p.files}`,
    `Активность: ${formatAgo(p.lastActivityAt)}`,
    `Компоненты: ${parts}`,
    `Флаги: ${flags}`,
    p.git ? `Git: ${p.git.branch || '—'}${p.git.dirty ? ', незакоммичено' : ''}${p.git.remote ? '' : ', нет remote'}` : 'Git: нет',
  ];

  if (dups.length) {
    lines.push('Клоны с участием проекта:');
    for (const g of dups) {
      const mine = (g.members || []).find((m) => m.projectId === p.id);
      lines.push(`  · ${g.kind === 'exact' ? 'точная копия' : `похожий, расхождение ${Math.round((g.drift || 0) * 100)}%`} — ${mine?.rel || '?'} (${formatBytes(g.wastedBytes || 0)})`);
    }
  }
  return lines.join('\n');
}

async function toolLeases() {
  const leases = activeLeases(await loadLeases());
  if (!leases.length) return 'Активных аренд нет.';
  const now = Date.now();
  return `Активных аренд: ${leases.length}\n${leases.map((l) => leaseLine(l, now)).join('\n')}`;
}

async function toolLeaseTake(args) {
  const project = String(args.project || '').trim();
  const rel = String(args.file || args.rel || '.').trim();
  const owner = String(args.owner || '').trim();
  if (!project) throw new Error('Укажите проект');
  if (!owner) throw new Error('Укажите владельца: owner');

  const state = await getState();
  const p = findProjectEntry(state, project.toLowerCase());
  const projectPath = p ? p.path : project;
  const ttlMin = clampInt(args.ttl, DEFAULT_TTL_MINUTES, 1, 24 * 60);

  const res = await acquireLease({
    project: projectPath,
    rel,
    owner,
    ttlMs: ttlMin * 60000,
    reason: String(args.reason || ''),
    force: Boolean(args.force),
  });

  if (!res.ok) {
    const who = res.clashes.map((c) => `${c.owner} (до ${c.expiresAt})`).join(', ');
    return `Отказано: файл уже под арендой — ${who}. Конфликт записан в журнал.`;
  }
  await appendEvent('lease.acquired', { project: res.lease.project, rel, owner });
  const forced = res.forced ? `, перехвачено: ${res.forced}` : '';
  return `Аренда взята: ${res.lease.project} / ${rel} — ${owner} на ${ttlMin} мин${forced}`;
}

async function toolLeaseRelease(args) {
  const project = String(args.project || '').trim();
  const rel = String(args.file || args.rel || '.').trim();
  const owner = String(args.owner || '').trim();
  if (!project || !owner) throw new Error('Укажите проект и владельца (owner)');

  const state = await getState();
  const p = findProjectEntry(state, project.toLowerCase());
  const res = await releaseLease({ project: p ? p.path : project, rel, owner });
  if (!res.ok) {
    return res.reason === 'not-owner'
      ? `Аренда принадлежит другому владельцу (${res.lease?.owner}).`
      : 'Такой аренды нет — возможно, срок истёк.';
  }
  await appendEvent('lease.released', { project: res.lease.project, rel, owner });
  return `Аренда освобождена: ${res.lease.project} / ${rel} — ${owner}`;
}

async function toolDups(args) {
  const state = await getState();
  const kind = String(args.kind || 'all').toLowerCase();
  const limit = clampInt(args.limit, 15, 1, 50);

  let groups = state.dupGroups || [];
  if (kind === 'exact' || kind === 'near') groups = groups.filter((g) => g.kind === kind);
  groups = groups.slice().sort((a, b) => (b.wastedBytes || 0) - (a.wastedBytes || 0)).slice(0, limit);
  if (!groups.length) return 'Групп клонов нет.';

  const lines = groups.map((g) => {
    const label = g.kind === 'exact' ? 'точная копия' : `похожий, расхождение ${Math.round((g.drift || 0) * 100)}%`;
    const files = (g.members || []).map((m) => m.rel).slice(0, 3).join(' | ');
    const more = (g.members || []).length > 3 ? ` +${g.members.length - 3}` : '';
    return `· ${label} · ${formatBytes(g.wastedBytes || 0)} · ${g.lines} строк\n    ${files}${more}`;
  });
  return `Групп: ${groups.length}${kind === 'all' ? '' : ` (${kind})`}\n${lines.join('\n')}`;
}

async function toolCleanup(args) {
  const state = await getState();
  const view = buildCleanupView(state, {
    kind: String(args.kind || 'exact').toLowerCase() === 'near' ? 'near' : 'exact',
    minBytes: clampInt(args.minBytes, 0, 0, Number.MAX_SAFE_INTEGER),
    limit: clampInt(args.limit, 15, 1, 50),
  });
  if (!view.totalFiles) return 'Кандидатов на удаление нет.';
  const lines = view.projects.slice(0, 10).map((p) => `· ${p.name} — ${formatBytes(p.wastedBytes)} в ${p.files} файлах${p.whole ? ' (проект целиком неуникален)' : ''}`);
  return [
    `Можно освободить: ${formatBytes(view.totalBytes)} (${view.totalFiles} файлов, ${formatNum(view.totalLines)} строк)`,
    `Групп: ${view.groups}${view.wholeProjects?.length ? ` · целиком неуникальные проекты: ${view.wholeProjects.length}` : ''}`,
    ...lines,
  ].join('\n');
}

async function toolBrief() {
  const state = await getState();
  const leases = await buildLeasesView();
  return await buildBriefText(state, leases);
}

async function toolHandoffWrite(args) {
  const project = String(args.project || '').trim();
  const owner = String(args.owner || '').trim();
  if (!project) throw new Error('Укажите проект');
  if (!owner) throw new Error('Укажите владельца: owner');

  const state = await getState();
  const p = findProjectEntry(state, project.toLowerCase());
  const target = p
    ? { projectId: p.id, projectPath: p.path, projectName: p.name }
    : (fs.existsSync(project) ? { projectId: null, projectPath: project, projectName: path.basename(project) } : null);
  if (!target) throw new Error(`Проект не найден: ${project}`);

  const files = Array.isArray(args.files)
    ? args.files.map(String).filter(Boolean)
    : (args.files ? String(args.files).split(/[,\s]+/).filter(Boolean) : []);

  await appendHandoff({
    projectId: target.projectId,
    projectPath: target.projectPath,
    projectName: target.projectName,
    owner,
    note: args.note || '',
    summary: args.summary || '',
    files,
  });
  await appendEvent('handoff.written', {
    project: target.projectName, owner, note: String(args.note || '').slice(0, 80), files: files.length,
  });
  const more = args.summary ? `\n${args.summary}` : '';
  return `Handoff записан: ${target.projectName} ← ${owner}\n${args.note || '(без заметки)'}${more}`;
}

async function toolHandoffRead(args) {
  const project = String(args.project || '').trim();
  if (!project) throw new Error('Укажите проект');

  const state = await getState();
  const p = findProjectEntry(state, project.toLowerCase());
  const target = p
    ? { projectId: p.id, projectPath: p.path, projectName: p.name }
    : (fs.existsSync(project) ? { projectId: null, projectPath: project, projectName: path.basename(project) } : null);
  if (!target) throw new Error(`Проект не найден: ${project}`);

  const h = await latestHandoffForTarget(target);
  if (!h) return `Handoff для ${target.projectName} ещё не записан — агенты не передавали контекст.`;
  const lines = [
    `Последняя сессия · ${target.projectName}`,
    `кто: ${h.owner} · ${formatAgo(h.ts)}`,
  ];
  if (h.note) lines.push(`что сделал: ${h.note}`);
  if (h.summary) lines.push(`подробнее: ${h.summary}`);
  if (h.files && h.files.length) lines.push(`файлы: ${h.files.join(', ')}`);
  return lines.join('\n');
}

async function toolRefresh(args) {
  const cfg = await requireConfig();
  const state = await getState();
  const q = String(args.name || '').trim();
  if (!q) throw new Error('Укажите проект');
  const p = findProjectEntry(state, q.toLowerCase());
  if (!p) throw new Error(`Проект не найден: ${q}`);

  const result = await refreshProjectState(state, p.path, cfg);
  if (!result) throw new Error(`Проект исчез с диска: ${p.path}`);
  await saveState(state);
  await appendEvent('project.refreshed', {
    project: result.project.name,
    score: result.project.score,
    scoreBefore: result.before.score,
    stage: result.project.stage,
  });
  const moved = result.before.score === result.after.score
    ? 'без изменений'
    : `${result.before.score} → ${result.after.score}`;
  return `${result.project.name}: скор ${moved} · стадия ${result.after.stage} · строк ${formatNum(result.project.loc)}`;
}

// ─────────────────────────────── Реестр инструментов

const TOOLS = [
  {
    name: 'vibe_status',
    description: 'Сводка по портфелю проектов: сколько проектов, стадии, клоны, аренды, сколько требуют решения.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolStatus,
  },
  {
    name: 'vibe_projects',
    description: 'Список проектов с фильтрами. Сортировка по приоритету, скору, активности или имени.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', description: 'S0…S5' },
        flag: { type: 'string', description: 'stale, nogit, noremote, dirty, noreadme, notests, dups, orphan' },
        sort: { type: 'string', enum: ['priority', 'score', 'activity', 'name'] },
        limit: { type: 'number', description: '1…100, по умолчанию 20' },
      },
      additionalProperties: false,
    },
    handler: toolProjects,
  },
  {
    name: 'vibe_project',
    description: 'Карточка проекта: скор по компонентам, флаги, git, активность и клоны с его участием.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя, id или часть имени' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: toolProject,
  },
  {
    name: 'vibe_leases',
    description: 'Активные аренды файлов: кто, что и на сколько взял.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolLeases,
  },
  {
    name: 'vibe_lease_take',
    description: 'Взять аренду на файл или проект целиком перед правкой. Просроченная снимается сама.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        file: { type: 'string', description: 'Относительный путь или "." для проекта целиком' },
        owner: { type: 'string', description: 'Твоё имя агента' },
        ttl: { type: 'number', description: 'Минуты, по умолчанию 30' },
        reason: { type: 'string' },
        force: { type: 'boolean', description: 'Перехватить чужую аренду (пишется в журнал конфликтов)' },
      },
      required: ['project', 'owner'],
      additionalProperties: false,
    },
    handler: toolLeaseTake,
  },
  {
    name: 'vibe_lease_release',
    description: 'Освободить аренду после правки.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, file: { type: 'string' }, owner: { type: 'string' } },
      required: ['project', 'owner'],
      additionalProperties: false,
    },
    handler: toolLeaseRelease,
  },
  {
    name: 'vibe_dups',
    description: 'Группы клонов: точные копии и похожие файлы с расхождением.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['all', 'exact', 'near'] }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    handler: toolDups,
  },
  {
    name: 'vibe_cleanup',
    description: 'Кандидаты на удаление: неканонические копии и сколько места они занимают.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['exact', 'near'] }, minBytes: { type: 'number' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    handler: toolCleanup,
  },
  {
    name: 'vibe_brief',
    description: 'Готовый контекст для новой сессии: метрики, что требует решения, аренды, топ клонов и что делать дальше.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: toolBrief,
  },
  {
    name: 'vibe_refresh',
    description: 'Пересчитать один проект (~0.2 с) вместо полного скана (~12 с).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: toolRefresh,
  },
  {
    name: 'vibe_handoff_write',
    description: 'Записать handoff-пакет: что агент сделал в конце сессии (чтобы следующий стартовал с контекста).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Имя, id или путь проекта' },
        owner: { type: 'string', description: 'Твоё имя агента' },
        note: { type: 'string', description: 'Коротко: что сделано' },
        summary: { type: 'string', description: 'Подробнее: решения, грабли, что брать дальше' },
        files: { type: 'array', items: { type: 'string' }, description: 'Файлы, которые трогал агент' },
      },
      required: ['project', 'owner'],
      additionalProperties: false,
    },
    handler: toolHandoffWrite,
  },
  {
    name: 'vibe_handoff_read',
    description: 'Прочитать последний handoff проекта: кто и что делал в предыдущей сессии.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Имя, id или путь проекта' } },
      required: ['project'],
      additionalProperties: false,
    },
    handler: toolHandoffRead,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ─────────────────────────────── JSON-RPC

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function codeOf(flag) {
  return typeof flag === 'string' ? flag : (flag.code || flag.kind || '');
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Ошибка инструмента возвращается как результат с isError — так советует MCP. */
function toolResult(payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function toolFailure(err) {
  return { content: [{ type: 'text', text: `Ошибка: ${err?.message || err}` }], isError: true };
}

export async function handleMessage(raw) {
  let req;
  try {
    req = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return fail(null, -32700, 'Не удалось разобрать JSON');
  }
  if (Array.isArray(req)) {
    const answers = [];
    for (const item of req) {
      const answer = await handleMessage(item);
      if (answer) answers.push(answer);
    }
    return answers.length ? answers : null;
  }
  if (!req || typeof req !== 'object') return fail(null, -32600, 'Некорректный запрос');

  const { id, method, params } = req;
  // Уведомление (без id) ответа не требует.
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case 'ping':
        return isNotification ? null : ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case 'tools/call': {
        const tool = TOOL_BY_NAME.get(params?.name);
        if (!tool) return fail(id, -32602, `Неизвестный инструмент: ${params?.name}`);
        try {
          const payload = await tool.handler(params.arguments || {});
          return ok(id, toolResult(payload));
        } catch (err) {
          return ok(id, toolFailure(err));
        }
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      default:
        return isNotification ? null : fail(id, -32601, `Метод не поддерживается: ${method}`);
    }
  } catch (err) {
    return isNotification ? null : fail(id, -32603, err?.message || 'Внутренняя ошибка');
  }
}

/**
 * Цикл stdio: читаем строки, отвечаем в stdout. Логи — только в stderr.
 * @param {{stdin?: import('node:stream').Readable, stdout?: import('node:stream').Writable}} [streams]
 */
export function startMcpServer(streams = {}) {
  const stdin = streams.stdin || process.stdin;
  const stdout = streams.stdout || process.stdout;
  let buffer = '';
  let pending = 0;
  let ended = false;

  const send = (message) => {
    if (!message) return;
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  /**
   * Инструменты читают состояние с диска, поэтому ответ асинхронный.
   * Выходим только когда stdin закрыт И все запросы отвечены — иначе теряем
   * последние ответы: `end` приходит, пока первый await ещё висит.
   */
  const finishIfDone = () => {
    if (ended && pending === 0) process.exit(0);
  };

  const handleLine = async (line) => {
    pending += 1;
    try {
      const answer = await handleMessage(line);
      if (Array.isArray(answer)) answer.forEach(send);
      else send(answer);
    } catch (err) {
      process.stderr.write(`[vibe-mcp] ${err?.message || err}\n`);
    } finally {
      pending -= 1;
      finishIfDone();
    }
  };

  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });

  stdin.on('end', () => {
    ended = true;
    const tail = buffer.trim();
    if (tail) handleLine(tail);
    finishIfDone();
  });

  process.stderr.write('[vibe-mcp] сервер запущен\n');
}

/** @returns {Array<{name: string, description: string}>} для smoke-тестов и документации */
export function listToolNames() {
  return TOOLS.map(({ name, description }) => ({ name, description }));
}
