/**
 * PreToolUse-хук записи (M4): атрибуция правок агентам.
 *
 * Проблема: ОС не сообщает, кто изменил файл (все агенты под одним
 * пользователем), поэтому панель знает только «файл изменился». Имя появляется,
 * если агент взял аренду. Хук вызывается агентом перед каждой записью и:
 *   - аренда на файл уже есть → ничего не делает (watch атрибутирует держателю);
 *   - аренды нет → берёт короткую «автоаренду» от имени агента
 *     (env.VIBE_AGENT, иначе session-<id>) — имя попадает в ленту автоматически.
 *
 * Хук в мягком режиме всегда возвращает allow: он про атрибуцию, не про запрет.
 * Все операции принимают now/leasesFile/projects — тестируется без сна.
 */
import path from 'node:path';
import { acquireLease, findLease, loadLeases, recordConflict } from './leases.js';
import { appendEvent } from './store.js';

const normRel = (p) => String(p || '').replace(/\\/g, '/');

/** Путь записываемого файла из входа хука (Write/Edit/ApplyPatch/NotebookEdit). */
export function extractWrittenPath(input = {}) {
  const ti = input.tool_input || {};
  const p = ti.file_path || ti.path || ti.notebook_path || ti.filePath;
  return p ? String(p) : null;
}

/** Проект по длиннейшему префиксу (та же логика, что в watch.js). */
function projectFor(projects, filePath) {
  const target = path.resolve(filePath);
  let best = null;
  for (const p of projects) {
    const root = path.resolve(p.path);
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (!best || root.length > path.resolve(best.path).length) best = p;
    }
  }
  return best || null;
}

/**
 * Обрабатывает вход PreToolUse.
 * @param {object} input {tool_name, tool_input, session_id?}
 * @param {object} opts {projects, env?, now?, ttlMs?, leasesFile?}
 * @returns {{action: 'allow', reason: string, owner?: string, holder?: string}}
 */
export async function handlePreToolUse(input, opts = {}) {
  const now = opts.now ?? Date.now();
  const env = opts.env || {};
  const filePath = extractWrittenPath(input);
  if (!filePath) return { action: 'allow', reason: 'no-path' };

  const project = projectFor(opts.projects || [], filePath);
  if (!project) return { action: 'allow', reason: 'outside-projects' };

  const rel = normRel(path.relative(path.resolve(project.path), path.resolve(filePath))) || '.';
  const selfOwner = String(env.VIBE_AGENT || '').trim()
    || `session-${String(env.CLAUDE_SESSION_ID || env.ZCODE_SESSION_ID || 'unknown').slice(-6)}`;

  const store = await loadLeases(opts.leasesFile);
  const existing = findLease(store, project.path, rel, now);
  if (existing) {
    // Раньше здесь просто «аренда есть — разрешаем», и запись под ЧУЖОЙ арендой
    // была неотличима от записи владельцем: активность приписывалась держателю,
    // а реальный писатель оставался неизвестен (Приоритет 3).
    if (String(existing.owner) !== selfOwner) {
      await reportViolation({
        project, rel, holder: existing.owner, requester: selfOwner, now, opts,
        note: `запись в файл под чужой арендой ${existing.owner}`,
      });
      return { action: 'allow', reason: 'lease-clash', owner: existing.owner, holder: existing.owner };
    }
    return { action: 'allow', reason: 'leased', owner: existing.owner };
  }

  const res = await acquireLease({
    project: project.path,
    rel,
    owner: selfOwner,
    ttlMs: opts.ttlMs ?? 15 * 60 * 1000,
    reason: 'автоаренда: запись инструментом агента',
    now,
    filePath: opts.leasesFile,
  });
  if (res.ok) return { action: 'allow', reason: 'auto-leased', owner: selfOwner };

  // Мягкий режим: не блокируем, но фиксируем. Здесь известны и писатель
  // (requester), и держатель (holder) — watch писателя не знает.
  const holder = res.clashes[0]?.owner ?? null;
  await reportViolation({
    project, rel, holder, requester: selfOwner, now, opts,
    note: `запись в файл под арендой ${holder || '?'}`,
  });
  return { action: 'allow', reason: 'lease-clash', holder };
}

/** Пишет нарушение в журнал конфликтов и в живую ленту событий. */
async function reportViolation({ project, rel, holder, requester, now, opts, note }) {
  await recordConflict({
    type: 'write-under-lease',
    project: project.path,
    rel,
    holder,
    requester,
    note,
    now,
    filePath: opts.conflictsFile,
  });
  await appendEvent('lease.violation', {
    project: project.name,
    projectPath: project.path,
    rel,
    holder,
    requester,
    confirmed: true,
    source: 'write-hook',
  }, { dedup: false, filePath: opts.eventsFile });
}
