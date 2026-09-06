/**
 * Аренды файлов (M3, паттерн Beads): advisory-локи с TTL.
 *
 * Два агента не должны писать в один файл одновременно. Аренда добровольная:
 * агенты берут её перед правкой (правила им генерирует `vibe agents-md`).
 * Просроченная аренда считается освобождённой сама — «брошенных» локов нет.
 * Все операции берут `now` параметром — тестируется без сна.
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LEASES_PATH, CONFLICTS_PATH, VIBE_DIR, ensureVibeDir } from './config.js';

export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Ротация журнала конфликтов, чтобы файл не рос вечно. */
const CONFLICTS_ROTATE_AT = 300;
const CONFLICTS_KEEP = 200;

const normProject = (p) => path.resolve(String(p || ''));
const normRel = (rel) => {
  const s = String(rel || '.').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
  return s === '' ? '.' : s;
};

/**
 * Пересекаются ли две аренды одного проекта:
 * аренда на весь проект ('.') пересекается с любой арендой проекта.
 */
function overlaps(relA, relB) {
  return relA === '.' || relB === '.' || relA === relB;
}

export async function loadLeases(filePath = LEASES_PATH) {
  try {
    const store = JSON.parse(await readFile(filePath, 'utf8'));
    return { schema: 1, leases: [], ...store };
  } catch {
    return { schema: 1, leases: [] };
  }
}

export async function saveLeases(store, filePath = LEASES_PATH) {
  await ensureVibeDir();
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf8');
  return filePath;
}

export function isExpired(lease, now = Date.now()) {
  return Date.parse(lease.expiresAt) <= now;
}

/** Активные аренды (просроченные не возвращаются). */
export function activeLeases(store, now = Date.now()) {
  return (store.leases || []).filter((l) => !isExpired(l, now));
}

/**
 * Аренда файла или проекта.
 *
 * @param {object} opts
 * @param {string} opts.project путь проекта
 * @param {string} opts.rel относительный путь файла или '.' для проекта целиком
 * @param {string} opts.owner имя агента-владельца
 * @param {number} [opts.ttlMs]
 * @param {string} [opts.reason]
 * @param {boolean} [opts.force] перехватить чужую аренду (записывается как конфликт)
 * @param {number} [opts.now]
 * @param {string} [opts.filePath] переопределение хранилища (для тестов)
 * @returns {{ok: true, lease: object, pruned: number, forced: number}
 *           |{ok: false, clashes: object[]}}
 */
export async function acquireLease({
  project, rel = '.', owner, ttlMs = DEFAULT_TTL_MS, reason = '', force = false, now = Date.now(), filePath,
}) {
  if (!owner || !String(owner).trim()) throw new Error('Аренда требует владельца (owner)');
  const store = await loadLeases(filePath);
  const before = store.leases.length;
  store.leases = store.leases.filter((l) => !isExpired(l, now));
  const pruned = before - store.leases.length;

  const projKey = normProject(project);
  const relKey = normRel(rel);
  const clashes = store.leases.filter((l) =>
    normProject(l.project) === projKey
    && String(l.owner) !== String(owner)
    && overlaps(normRel(l.rel), relKey));

  if (clashes.length && !force) {
    for (const c of clashes) {
      await recordConflict({
        type: 'blocked',
        project: projKey,
        rel: relKey,
        holder: c.owner,
        requester: owner,
        note: `файл под арендой до ${c.expiresAt}`,
        now,
        filePath: filePath ? pathJoinConflicts(filePath) : undefined,
      });
    }
    return { ok: false, clashes };
  }

  // Перехват: чужие пересекающиеся аренды снимаются, факт пишется в журнал конфликтов.
  if (clashes.length) {
    store.leases = store.leases.filter((l) => !clashes.includes(l));
    for (const c of clashes) {
      await recordConflict({
        type: 'forced',
        project: projKey,
        rel: relKey,
        holder: c.owner,
        requester: owner,
        note: `перехват аренды ${c.rel}`,
        now,
        filePath: filePath ? pathJoinConflicts(filePath) : undefined,
      });
    }
  }

  // Повторный take тем же владельцем обновляет его аренду, а не плодит дубли.
  store.leases = store.leases.filter((l) =>
    !(normProject(l.project) === projKey && String(l.owner) === String(owner) && overlaps(normRel(l.rel), relKey)));

  const lease = {
    id: `lease-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    project: projKey,
    rel: relKey,
    owner: String(owner),
    reason: String(reason || ''),
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    ttlMs,
  };
  store.leases.push(lease);
  await saveLeases(store, filePath);
  return { ok: true, lease, pruned, forced: clashes.length };
}

/**
 * Освобождение аренды владельцем.
 * @returns {{ok: true, lease: object} | {ok: false, reason: 'not-found' | 'not-owner', lease?: object}}
 */
export async function releaseLease({ project, rel = '.', owner, now = Date.now(), filePath }) {
  const store = await loadLeases(filePath);
  const projKey = normProject(project);
  const relKey = normRel(rel);
  const idx = store.leases.findIndex((l) =>
    normProject(l.project) === projKey && normRel(l.rel) === relKey);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  const lease = store.leases[idx];
  if (String(lease.owner) !== String(owner)) {
    return { ok: false, reason: 'not-owner', lease };
  }
  store.leases.splice(idx, 1);
  await saveLeases(store, filePath);
  return { ok: true, lease };
}

/** Активная аренда конкретного файла (или проекта, если rel='.'). */
export function findLease(store, project, rel, now = Date.now()) {
  const projKey = normProject(project);
  const relKey = normRel(rel);
  return activeLeases(store, now).find((l) =>
    normProject(l.project) === projKey && (normRel(l.rel) === relKey || normRel(l.rel) === '.'))
    || null;
}

function pathJoinConflicts(leasesFilePath) {
  return path.join(path.dirname(leasesFilePath), 'conflicts.jsonl');
}

/** Запись конфликта в append-only журнал (с ротацией). */
export async function recordConflict({
  type, project, rel, holder, requester, note = '', now = Date.now(), filePath = CONFLICTS_PATH,
}) {
  await ensureVibeDir();
  const entry = {
    ts: new Date(now).toISOString(),
    type,
    project: normProject(project),
    rel: normRel(rel),
    holder: holder ?? null,
    requester: requester ?? null,
    note,
  };
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  await rotateConflictsIfNeeded(filePath);
  return entry;
}

async function rotateConflictsIfNeeded(filePath) {
  try {
    const txt = await readFile(filePath, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (lines.length <= CONFLICTS_ROTATE_AT) return;
    await writeFile(filePath, `${lines.slice(-CONFLICTS_KEEP).join('\n')}\n`, 'utf8');
  } catch { /* файла ещё нет */ }
}

/** Последние конфликты (новые сверху). */
export async function readConflicts(limit = 50, filePath = CONFLICTS_PATH) {
  try {
    const txt = await readFile(filePath, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    const out = [];
    for (const line of lines.slice(-limit)) {
      try { out.push(JSON.parse(line)); } catch { /* битая строка */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export async function countConflicts(filePath = CONFLICTS_PATH) {
  try {
    const txt = await readFile(filePath, 'utf8');
    return txt.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}
