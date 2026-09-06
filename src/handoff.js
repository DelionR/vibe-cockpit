/**
 * Handoff-пакеты (M4, Приоритет 2): что агент сделал в конце сессии.
 *
 * Проблема: агенты не знают, чем закончил предыдущий — контекст передаётся
 * ручным копированием. Handoff — append-only журнал «эстафеты»: агент пишет
 * короткий summary в конце сессии, следующий читает его через `vibe_brief`
 * (или `vibe_handoff_read`) и стартует с готового контекста.
 *
 * Хранилище — `.vibe/handoffs.jsonl` (одна строка JSON на запись), ротация
 * как у conflicts.jsonl, чтобы файл не рос вечно. Ноль зависимостей.
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VIBE_DIR, ensureVibeDir } from './config.js';

export const HANDOFF_PATH = path.join(VIBE_DIR, 'handoffs.jsonl');

/** Ротация журнала: держим последние KEEP записей. */
const ROTATE_AT = 600;
const KEEP = 400;

/**
 * Записать handoff-пакет.
 * @param {object} opts
 * @param {string} [opts.projectId] id проекта из state.json
 * @param {string} [opts.projectPath] путь на диске (резолв, если нет id)
 * @param {string} [opts.projectName] имя проекта
 * @param {string} opts.owner имя агента, который завершает сессию
 * @param {string} [opts.note] коротко: что сделано
 * @param {string} [opts.summary] длиннее: решения, грабли, что брать дальше
 * @param {string[]} [opts.files] файлы, которые трогал агент
 * @param {number} [opts.now]
 * @param {string} [opts.filePath] переопределение хранилища (для тестов)
 * @returns {Promise<object>} записанная запись
 */
export async function appendHandoff({
  projectId, projectPath, projectName, owner, note = '', summary = '', files = [], now = Date.now(), filePath = HANDOFF_PATH,
}) {
  if (!owner || !String(owner).trim()) throw new Error('Handoff требует владельца (owner)');
  await ensureVibeDir();
  const entry = {
    ts: new Date(now).toISOString(),
    projectId: projectId ?? null,
    projectPath: projectPath ?? null,
    projectName: projectName ?? null,
    owner: String(owner),
    note: String(note || '').trim(),
    summary: String(summary || '').trim(),
    files: (Array.isArray(files) ? files : String(files || '').split(/[,\s]+/)).map(String).filter(Boolean),
  };
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  await rotateHandoffsIfNeeded(filePath);
  return entry;
}

/** Прочитать все записи (старые сверху → новые снизу). */
export async function loadHandoffs(filePath = HANDOFF_PATH) {
  try {
    const txt = await readFile(filePath, 'utf8');
    const out = [];
    for (const line of txt.split('\n').filter(Boolean)) {
      try { out.push(JSON.parse(line)); } catch { /* битая строка — пропускаем */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Последний handoff по id проекта. */
export async function latestHandoffForProject(projectId, filePath = HANDOFF_PATH) {
  const all = await loadHandoffs(filePath);
  const id = String(projectId);
  const matches = all.filter((h) => String(h.projectId) === id);
  return matches.length ? matches[matches.length - 1] : null;
}

/**
 * Найти последний handoff для проекта по любому из доступных ключей.
 * Порядок резолва: id → путь (нормализованный) → имя. Первое совпадение
 * побеждает; внутри ключа — последняя (самая свежая) запись.
 */
export async function latestHandoffForTarget(target = {}, filePath = HANDOFF_PATH) {
  const all = await loadHandoffs(filePath);
  if (!all.length) return null;
  if (target.projectId) {
    const byId = all.filter((h) => String(h.projectId) === String(target.projectId));
    if (byId.length) return byId[byId.length - 1];
  }
  if (target.projectPath) {
    const normPath = path.resolve(target.projectPath);
    const byPath = all.filter((h) => h.projectPath && path.resolve(h.projectPath) === normPath);
    if (byPath.length) return byPath[byPath.length - 1];
  }
  if (target.projectName) {
    const nm = String(target.projectName).toLowerCase();
    const byName = all.filter((h) => String(h.projectName || '').toLowerCase() === nm);
    if (byName.length) return byName[byName.length - 1];
  }
  return null;
}

/**
 * Последние handoff-записи — по проекту либо по всему портфелю.
 * Нужно, чтобы видеть активность агентов в соседних проектах: одиночного
 * «последнего пакета» для этого мало.
 *
 * @param {object} [target] { projectId, projectPath, projectName } — если пусто,
 *   возвращаются записи по всем проектам (кросс-проектная лента).
 * @param {object} [o]
 * @param {number} [o.limit=10] сколько последних записей вернуть
 * @param {string} [o.filePath]
 * @returns {Promise<object[]>} новые сверху (лента)
 */
export async function recentHandoffs(target = {}, { limit = 10, filePath = HANDOFF_PATH } = {}) {
  const all = await loadHandoffs(filePath);
  const t = target || {};
  const pid = t.projectId ? String(t.projectId) : null;
  const ppath = t.projectPath ? path.resolve(String(t.projectPath)) : null;
  const pname = t.projectName ? String(t.projectName).toLowerCase() : null;

  const out = (pid || ppath || pname)
    ? all.filter((h) => (
      (pid != null && String(h.projectId || '') === pid)
      || (ppath && h.projectPath && path.resolve(String(h.projectPath)) === ppath)
      || (pname && String(h.projectName || '').toLowerCase() === pname)
    ))
    : all;

  const n = Math.max(1, Number(limit) || 10);
  return out.slice(-n).reverse(); // журнал append-only: свежие в конце → переворачиваем
}

async function rotateHandoffsIfNeeded(filePath) {
  try {
    const txt = await readFile(filePath, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (lines.length <= ROTATE_AT) return;
    await writeFile(filePath, `${lines.slice(-KEEP).join('\n')}\n`, 'utf8');
  } catch { /* файла ещё нет */ }
}
