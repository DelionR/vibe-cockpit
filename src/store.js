import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STATE_PATH, EVENTS_PATH, SIGNATURES_PATH, VIBE_DIR, ensureVibeDir } from './config.js';
import { computeScore, computeFlags, priorityOf, STAGE_LABEL, stageOf } from './score.js';
import { computeValue, computeValuePriority, valueTier } from './value.js';
import { slugify } from './util.js';
import { collectProjectMetrics } from './scanner.js';
import { enrichWithGit } from './git.js';
import { nearGroupsFromEntries, readCandidates, signaturesOf, NEAR_THRESHOLD } from './dup.js';

function uniqueId(base, taken) {
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  taken.add(id);
  return id;
}

/** Первичная сборка записи проекта из сырых данных сканирования. */
function buildProjectEntry(raw, id, now) {
  const lastActivityMs = Math.max(
    raw.lastMtimeMs || 0,
    raw.git?.lastCommitAt ? Date.parse(raw.git.lastCommitAt) : 0,
  );
  return {
    id,
    name: raw.name,
    path: raw.path,
    stack: raw.stack,
    detectedReason: raw.detectedReason,
    files: raw.files,
    codeFiles: raw.codeFiles,
    testFiles: raw.testFiles,
    loc: raw.loc,
    bytes: raw.bytes,
    locByLang: raw.locByLang,
    has: raw.has,
    names: raw.names,
    truncated: raw.truncated,
    git: raw.git || null,
    lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    scannedAt: now,
  };
}

/**
 * Пересчёт производных полей проекта (доли дублей, скор, стадия, флаги,
 * ось ценности/монетизации и бизнес-приоритет).
 * @param {object} cfg конфиг панели (нужен для ручных весов ценности и весов рейтинга)
 */
function applyDerived(p, dupLines, cfg) {
  p.dupLines = dupLines;
  p.dupShare = p.loc > 0 ? Math.min(1, p.dupLines / p.loc) : 0;
  const s = computeScore(p, cfg && cfg.score ? cfg.score.weights : null);
  p.score = s.score;
  p.scoreBase = s.base;
  p.scoreParts = s.parts;
  p.scorePenalties = s.penalties;
  p.stage = stageOf(s.score);
  p.stageLabel = STAGE_LABEL[p.stage];
  p.flags = computeFlags(p);
  p.priority = priorityOf(p);

  // Ось ценности (монетизация) — ортогональна готовности, считается отдельно.
  const v = computeValue(p, cfg);
  p.value = v.value;
  p.valueSource = v.source;
  p.valueSignals = v.signals;
  p.valueTier = valueTier(v.value).code;
  p.valuePriority = computeValuePriority(p, cfg);
}

/**
 * Канон в группе: максимум скора, при равенстве — более свежий.
 * Проекты без id (путь не распознался) каноном не становятся.
 * Заодно считает wastedBytes/wastedLines — объём неканонических копий.
 */
function markCanonicalInGroup(g, scoreById, freshById) {
  let best = -1;
  let bestScore = -1;
  let bestFresh = -1;
  g.members.forEach((m, i) => {
    const score = m.projectId != null ? (scoreById.get(m.projectId) ?? 0) : -1;
    const fresh = m.projectId != null ? (freshById.get(m.projectId) ?? 0) : -1;
    if (score > bestScore || (score === bestScore && fresh > bestFresh)) {
      best = i;
      bestScore = score;
      bestFresh = fresh;
    }
  });
  g.members.forEach((m, i) => { m.isCanonical = i === best; });
  g.wastedBytes = g.members.reduce((a, m) => a + (m.isCanonical ? 0 : m.size), 0);
  g.wastedLines = g.members.reduce((a, m) => a + (m.isCanonical ? 0 : m.lines), 0);
}

/**
 * Превращает сырые данные сканирования в состояние панели:
 * присваивает id, выбирает канон в группах клонов, считает экономию,
 * долю дублей, скор, стадию, флаги и приоритет.
 */
export function buildState(scanResult, cfg) {
  const taken = new Set();
  const now = new Date().toISOString();
  const projects = scanResult.projects.map((raw) => {
    const base = slugify(raw.name || path.basename(raw.path));
    return buildProjectEntry(raw, uniqueId(base, taken), now);
  });

  const byPath = new Map(projects.map((p) => [path.resolve(p.path), p]));

  const dupLinesByProject = new Map();
  const dupGroups = scanResult.dupGroups.map((g, i) => {
    const members = g.members.map((m) => {
      const project = byPath.get(path.resolve(m.project));
      const member = {
        projectId: project ? project.id : null,
        projectPath: m.project,
        rel: m.rel,
        size: m.size,
        lines: m.lines,
      };
      if (m.sim != null) member.sim = m.sim;
      return member;
    });
    for (const m of members) {
      if (!m.projectId) continue;
      dupLinesByProject.set(m.projectId, (dupLinesByProject.get(m.projectId) || 0) + m.lines);
    }
    return {
      id: `dup-${i + 1}`,
      kind: g.kind || 'exact',
      hash: g.hash ?? null,
      similarity: g.similarity ?? 1,
      drift: g.drift ?? 0,
      lines: g.lines,
      size: g.size,
      projectCount: g.projectCount,
      crossProject: g.crossProject,
      members,
    };
  });

  // Проход 1: скор без учёта дублей — нужен, чтобы выбрать канон в группах
  // (канон = самый ценный проект, а скор зависит от дублей — разрываем цикл).
  for (const p of projects) applyDerived(p, 0, cfg);

  const scoreById = new Map(projects.map((p) => [p.id, p.score]));
  const freshById = new Map(projects.map((p) => [p.id, p.lastActivityAt ? Date.parse(p.lastActivityAt) : 0]));

  for (const g of dupGroups) markCanonicalInGroup(g, scoreById, freshById);

  // Проход 2: настоящий скор с долей дублей.
  for (const p of projects) {
    applyDerived(p, dupLinesByProject.get(p.id) || 0, cfg);
  }

  const state = {
    schema: 3,
    generatedAt: now,
    roots: cfg.roots,
    scan: scanResult.stats,
    projects,
    dupGroups,
  };
  applyCloneValueInheritance(state, cfg);
  return state;
}

/**
 * Клоны (не-канон в точных группах) наследуют ценность канонического источника.
 *
 * Зачем: авто-детект ценности (value.js) смотрит на артефакты конкретного
 * каталога. У копии могут случайно оказаться «коммерческие» маркеры (README с
 * ценами, имя с «sale»), и она получает бОльшую ценность, чем сам источник, —
 * а значит и бОльший бизнес-приоритет (valuePriority). Копия не может быть
 * коммерчески важнее своего источника, поэтому не-канон наследует ценность
 * канона, и его valuePriority пересчитывается. Ручной вес (valueSource=manual)
 * не переопределяется — это явная воля пользователя.
 */
export function applyCloneValueInheritance(state, cfg) {
  const byId = new Map((state.projects || []).map((p) => [p.id, p]));
  // Точные дубли — идентичные файлы: все копии одного источника.
  // Рёбра «не-канон → канон своей точной группы»; корень — узел без исходящего ребра.
  const edges = new Map();
  for (const g of state.dupGroups || []) {
    if (g.kind !== 'exact') continue;
    const canon = g.members.find((m) => m.isCanonical && m.projectId);
    if (!canon) continue;
    for (const m of g.members) {
      if (m.isCanonical || !m.projectId) continue;
      edges.set(m.projectId, canon.projectId);
    }
  }
  const resolveRoot = (id, seen = new Set()) => {
    let cur = id;
    while (edges.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = edges.get(cur);
    }
    return cur;
  };
  for (const childId of edges.keys()) {
    const child = byId.get(childId);
    const root = byId.get(resolveRoot(childId));
    if (!child || !root) continue;
    if (child.valueSource === 'manual') continue; // ручной вес — явная воля
    child.value = root.value;
    child.valueSource = 'inherited';
    child.valueSignals = [];
    child.valueTier = valueTier(child.value).code;
    child.valuePriority = computeValuePriority(child, cfg);
    child.isClone = true;
    child.cloneOf = root.id;
  }
}

export async function saveState(state) {
  await ensureVibeDir();
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  return STATE_PATH;
}

export async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function fingerprintOf(type, payload) {
  return createHash('sha256').update(`${type}|${JSON.stringify(payload)}`, 'utf8').digest('hex').slice(0, 16);
}

/** Fingerprint'ы уже записанных событий (для дедупа на записи). */
async function knownFingerprints(filePath = EVENTS_PATH) {
  try {
    const txt = await readFile(filePath, 'utf8');
    const out = new Set();
    for (const line of txt.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.fingerprint) out.add(e.fingerprint);
      } catch { /* битая строка — пропускаем */ }
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Журнал держим ограниченным: ротация при превышении, чтобы файл не рос вечно. */
const EVENTS_ROTATE_AT = 600;
const EVENTS_KEEP = 400;

async function rotateEventsIfNeeded() {
  try {
    const txt = await readFile(EVENTS_PATH, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    if (lines.length <= EVENTS_ROTATE_AT) return;
    await writeFile(EVENTS_PATH, `${lines.slice(-EVENTS_KEEP).join('\n')}\n`, 'utf8');
  } catch { /* журнала ещё нет — ротировать нечего */ }
}

/**
 * Дозапись события в append-only журнал.
 *
 * По умолчанию событие с уже существующим fingerprint не дублируется.
 * Для «живой» активности (правки файлов) передайте { dedup: false } —
 * иначе повторные правки с тем же скором/стадией выпадут из ленты.
 */
export async function appendEvent(type, payload, opts = {}) {
  const { dedup = true, filePath = EVENTS_PATH } = opts;
  await mkdir(VIBE_DIR, { recursive: true });
  const fingerprint = fingerprintOf(type, payload);
  if (dedup) {
    const seen = await knownFingerprints(filePath);
    if (seen.has(fingerprint)) return fingerprint;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), type, fingerprint, payload });
  await appendFile(filePath, `${line}\n`, 'utf8');
  if (filePath === EVENTS_PATH) await rotateEventsIfNeeded();
  return fingerprint;
}

/**
 * Пересобирает точные группы клонов с участием проекта после его пересчёта.
 *
 * Ограничение инкремента: пары «файл проекта ↔ файл чужого проекта», которых
 * не было в группах на момент полного скана, здесь не находятся (хешей чужих
 * одиночных файлов в состоянии нет). Их покажет следующий полный `vibe scan`.
 * Near-группы с участием проекта тоже не пересобираются — только полный скан.
 *
 * @param {object} state состояние панели (мутируется)
 * @param {string} projectId id проекта
 * @param {string} projectPath путь проекта
 * @param {Map<string, Array<{rel: string, size: number, lines: number}>>} newHashes хеши файлов проекта
 */
export function rebuildDupGroupsForProject(state, projectId, projectPath, newHashes) {
  const kept = [];
  for (const g of state.dupGroups) {
    const mine = g.members.filter((m) => m.projectId === projectId);
    if (!mine.length || g.kind !== 'exact' || !g.hash) {
      kept.push(g);
      continue;
    }
    const rest = g.members.filter((m) => m.projectId !== projectId);
    const mineNew = (newHashes.get(g.hash) || []).map((f) => ({
      projectId,
      projectPath,
      rel: f.rel,
      size: f.size,
      lines: f.lines,
    }));
    const members = [...rest, ...mineNew];
    if (members.length >= 2) {
      const projects = new Set(members.map((m) => m.projectId || m.projectPath));
      kept.push({ ...g, members, projectCount: projects.size, crossProject: projects.size > 1 });
    }
    // иначе группа распалась — не сохраняем
  }
  state.dupGroups = kept.map((g, i) => ({ ...g, id: `dup-${i + 1}` }));
  // Состав групп изменился — канон и экономия могли перейти к другому проекту.
  if (Array.isArray(state.projects)) {
    const scoreById = new Map(state.projects.map((p) => [p.id, p.score]));
    const freshById = new Map(state.projects.map((p) => [p.id, p.lastActivityAt ? Date.parse(p.lastActivityAt) : 0]));
    for (const g of state.dupGroups) markCanonicalInGroup(g, scoreById, freshById);
  }
}

/**
 * Агрегирует группы клонов в отчёт «кандидаты на удаление».
 * По умолчанию только точные клоны: near-копии различаются, их удалять нельзя.
 */
export function buildCleanupReport(state, { kind = 'exact', minBytes = 0 } = {}) {
  const groups = state.dupGroups.filter(
    (g) => (g.kind === 'near' ? 'near' : 'exact') === kind && g.wastedBytes > 0 && (g.wastedBytes || 0) >= minBytes,
  );

  const canonicalProjects = new Set();
  for (const g of state.dupGroups) {
    for (const m of g.members) {
      if (m.projectId && m.isCanonical) canonicalProjects.add(m.projectId);
    }
  }

  const byProject = new Map();
  let totalBytes = 0;
  let totalFiles = 0;
  let totalLines = 0;
  for (const g of groups) {
    for (const m of g.members) {
      if (m.isCanonical || !m.projectId) continue;
      totalBytes += m.size;
      totalFiles++;
      totalLines += m.lines;
      let rec = byProject.get(m.projectId);
      if (!rec) {
        const p = state.projects.find((x) => x.id === m.projectId);
        rec = { projectId: m.projectId, name: p ? p.name : m.projectPath, path: m.projectPath, wastedBytes: 0, wastedLines: 0, files: 0 };
        byProject.set(m.projectId, rec);
      }
      rec.wastedBytes += m.size;
      rec.wastedLines += m.lines;
      rec.files++;
    }
  }

  const projects = [...byProject.values()].sort((a, b) => b.wastedBytes - a.wastedBytes);
  return {
    kind,
    totalBytes,
    totalFiles,
    totalLines,
    groups: groups.length,
    projects,
    noCanonicalProjects: projects.filter((r) => !canonicalProjects.has(r.projectId)),
    nearWastedBytes: state.dupGroups
      .filter((g) => g.kind === 'near')
      .reduce((a, g) => a + (g.wastedBytes || 0), 0),
  };
}

/**
 * Инкрементальный пересчёт одного проекта: метрики с диска, git, группы
 * клонов (точные и near-по кэшу подписей) с его участием, скор и флаги.
 * Состояние мутируется.
 *
 * @returns {Promise<{before: object, after: object}|null>} скоры до/после; null — проект исчез
 */
export async function refreshProjectState(state, projectPath, cfg) {
  const index = state.projects.findIndex((p) => path.resolve(p.path) === path.resolve(projectPath));
  if (index < 0) return null;
  const before = { score: state.projects[index].score, stage: state.projects[index].stage };

  const raw = await collectProjectMetrics(projectPath, cfg);
  await enrichWithGit([raw]);

  const entry = buildProjectEntry(raw, state.projects[index].id, new Date().toISOString());

  // Near-группы пересобираются целиком из кэша подписей: чужие подписи не требуют
  // чтения файлов, подписи самого проекта считаются заново. Без кэша (первый
  // запуск после обновления) near-группы не трогаем — их обновит полный скан.
  await rebuildNearGroupsFromCache(state, entry, raw, cfg);

  rebuildDupGroupsForProject(state, entry.id, entry.path, raw.hashes || new Map());

  const dupLines = state.dupGroups.reduce(
    (a, g) => a + g.members.filter((m) => m.projectId === entry.id).reduce((s, m) => s + (m.lines || 0), 0),
    0,
  );
  applyDerived(entry, dupLines, cfg);
  state.projects[index] = entry;
  state.generatedAt = new Date().toISOString();
  applyCloneValueInheritance(state, cfg);

  return { before, after: { score: entry.score, stage: entry.stage }, project: entry };
}

/**
 * Полная пересборка near-групп состояния: подписи всех проектов берутся из кэша,
 * подписи пересчитываемого проекта — заново из его файлов. Кэш обновляется.
 */
async function rebuildNearGroupsFromCache(state, entry, raw, cfg) {
  const cache = await loadSignatures();
  if (!cache || !Array.isArray(cache.entries)) return;

  const target = path.resolve(entry.path);
  const others = cache.entries.filter((e) => path.resolve(e.file && e.file.project) !== target);

  const dupCfg = cfg.dup || {};
  const threshold = dupCfg.nearThreshold ?? NEAR_THRESHOLD;
  let newEntries = [];
  if (dupCfg.near !== false && Array.isArray(raw.dupMembers) && raw.dupMembers.length > 0) {
    const candidates = await readCandidates(raw.dupMembers, { minLines: dupCfg.minLines ?? 5 });
    newEntries = signaturesOf(candidates);
  }

  // nearGroupsFromEntries возвращает members в сыром формате скана (project) —
  // приводим к схеме состояния (projectId/projectPath), как это делает buildState.
  const byPath = new Map(state.projects.map((p) => [path.resolve(p.path), p]));
  const nearGroups = nearGroupsFromEntries([...others, ...newEntries], { threshold }).map((g) => ({
    ...g,
    members: g.members.map((m) => {
      const p = byPath.get(path.resolve(m.project));
      return {
        projectId: p ? p.id : null,
        projectPath: m.project,
        rel: m.rel,
        size: m.size,
        lines: m.lines,
        sim: m.sim,
      };
    }),
  }));

  state.dupGroups = [
    ...state.dupGroups.filter((g) => g.kind !== 'near'),
    ...nearGroups,
  ];

  await saveSignatures({ generatedAt: new Date().toISOString(), entries: [...others, ...newEntries] });
}

/** Кэш minhash-подписей: позволяет пересобирать near-группы без чтения чужих файлов. */
export async function loadSignatures() {
  try {
    return JSON.parse(await readFile(SIGNATURES_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveSignatures(cache) {
  await ensureVibeDir();
  // Тексты не храним — только метаданные файла и подпись, иначе кэш раздувается до десятков МБ.
  const lean = {
    ...cache,
    entries: (cache.entries || []).map((e) => ({
      file: {
        project: e.file.project, rel: e.file.rel, path: e.file.path,
        ext: e.file.ext, size: e.file.size, lines: e.file.lines,
      },
      sig: e.sig,
    })),
  };
  await writeFile(SIGNATURES_PATH, JSON.stringify(lean), 'utf8');
  return SIGNATURES_PATH;
}
