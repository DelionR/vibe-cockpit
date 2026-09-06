import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PANEL_ROOT, EVENTS_PATH, VIBE_DIR, REPORTS_DIR, loadConfig, saveConfig, compileIgnore,
} from './config.js';
import { PART_MAX, normalizeScoreWeights } from './score.js';
import { loadState, appendEvent, buildCleanupReport } from './store.js';
import { loadLeases, activeLeases, countConflicts } from './leases.js';
import { loadHandoffs } from './handoff.js';
import { runScan } from './pipeline.js';
import { writeReports } from './report.js';
import { daysSince, formatAgo, formatBytes } from './util.js';

const WEB_DIR = path.join(PANEL_ROOT, 'web');

/** Коды флагов состояния → визуальные классы фронтенда. */
const FLAG_KIND = {
  stale: 'stale',
  dups: 'dup',
  orphan: 'orphan',
  dirty: 'dirty',
  nogit: 'risk',
  noremote: 'risk',
  notests: 'risk',
  noreadme: 'risk',
};

/** Компоненты скора: внутренние ключи → ключи, которые ждёт фронтенд. */
const BREAKDOWN_MAP = {
  idea: 'vision',
  scaffold: 'scaffold',
  core: 'core',
  tests: 'tests',
  config: 'config',
  deploy: 'deploy',
  docs: 'docs',
};

/** Служебные слова в именах проектов-копий (salebot-backup, project-next16, …). */
const NOISE_TOKENS = new Set([
  'backup', 'upgrade', 'copy', 'offline', 'old', 'new', 'v2', 'v3',
  'final', 'test', 'tmp', 'archive', 'bak', 'fork', 'next', 'before', 'after',
]);

export function normalizeProjectName(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/\d{4}-\d{2}-\d{2}([t\-_]?\d*)/g, ' ');
  s = s.replace(/\d{8}([t\-_]?\d*)/g, ' ');
  s = s.replace(/[-_.]+/g, ' ');
  s = s.replace(/\d+/g, ' ');
  return s.split(/\s+/).filter((t) => t && t.length > 1 && !NOISE_TOKENS.has(t)).join(' ');
}

function pickCanonical(items) {
  let best = -1;
  items.forEach((m, i) => {
    if (best < 0) { best = i; return; }
    const a = items[best];
    if (m.score > a.score || (m.score === a.score && m.fresh > a.fresh)) best = i;
  });
  return best;
}

/**
 * Превращает состояние (.vibe/state.json) во view-модель для веб-дашборда.
 * Фронтенд не должен знать внутреннюю схему: вся адаптация здесь.
 */
export function buildView(state) {
  if (!state || !Array.isArray(state.projects)) {
    return {
      scannedAt: null,
      summary: { total: 0, withGit: 0, withTests: 0, stale60: 0 },
      projects: [], dupGroups: [], projectDupGroups: [], log: [],
    };
  }

  const scoreById = new Map(state.projects.map((p) => [p.id, p.score || 0]));
  const freshById = new Map(state.projects.map((p) => [p.id, p.lastActivityAt ? Date.parse(p.lastActivityAt) : 0]));

  // Сколько файлов проекта участвует в группах точных клонов
  const dupFilesById = new Map();
  for (const g of state.dupGroups || []) {
    for (const m of g.members || []) {
      if (!m.projectId) continue;
      dupFilesById.set(m.projectId, (dupFilesById.get(m.projectId) || 0) + 1);
    }
  }

  const projects = state.projects.map((p) => {
    const breakdown = {};
    for (const [k, v] of Object.entries(p.scoreParts || {})) {
      breakdown[BREAKDOWN_MAP[k] || k] = v;
    }
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      stage: p.stage,
      stageLabel: p.stageLabel,
      score: p.score,
      stack: Array.isArray(p.stack) ? p.stack : [],
      isGit: !!p.git,
      hasTests: (p.testFiles || 0) > 0 || !!(p.has && p.has.tests),
      testFiles: p.testFiles || 0,
      loc: p.loc || 0,
      files: p.files || 0,
      staleDays: daysSince(p.lastActivityAt),
      lastActivityMs: p.lastActivityAt ? Date.parse(p.lastActivityAt) : null,
      lastActivityAt: p.lastActivityAt,
      git: p.git || null,
      breakdown,
      penalties: (p.scorePenalties || []).map((x) => ({ value: Math.abs(x.value), reason: x.reason })),
      dup: { files: dupFilesById.get(p.id) || 0, total: p.files || 0, ratio: p.dupShare || 0 },
      flags: (p.flags || []).map((f) => ({ kind: FLAG_KIND[f.code] || 'risk', text: f.label })),
      // Ось ценности (монетизация) — ортогональна готовности, считается в store.applyDerived.
      value: p.value || 0,
      valueSource: p.valueSource || 'auto',
      valueTier: p.valueTier || 'M0',
      valuePriority: p.valuePriority || 0,
      valueSignals: (p.valueSignals || []).map((s) => ({ code: s.code, label: s.label, weight: s.weight })),
    };
  });

  // Группы клонов файлов: канон размечен в buildState; для старых состояний
  // (schema < 3) пересчитываем на месте по скору и свежести.
  const toViewGroup = (g) => {
    const members = (g.members || []).map((m) => ({
      projectName: path.basename(m.projectPath || ''),
      projectPath: m.projectPath,
      rel: m.rel,
      lines: m.lines,
      size: m.size,
      score: scoreById.get(m.projectId) || 0,
      fresh: freshById.get(m.projectId) || 0,
      isCanonical: typeof m.isCanonical === 'boolean' ? m.isCanonical : null,
    }));
    if (members.some((m) => m.isCanonical === null)) {
      const canonIdx = pickCanonical(members);
      members.forEach((m, i) => {
        if (m.isCanonical === null) m.isCanonical = i === canonIdx;
      });
    }
    members.forEach((m) => {
      delete m.score;
      delete m.fresh;
    });
    return {
      label: `${g.lines} строк · ${members.length} файл(ов)`,
      kind: g.kind || 'exact',
      drift: g.drift || 0,
      similarity: g.similarity ?? 1,
      wastedBytes: g.wastedBytes || 0,
      crossProject: !!g.crossProject,
      members,
    };
  };

  // Отдаём оба вида порознь (до 30 каждого), иначе топ по весу вытесняет near-группы
  // и фильтр «похожие» на фронте остаётся пустым.
  const allGroups = state.dupGroups || [];
  const dupGroups = [
    ...allGroups.filter((g) => g.kind !== 'near').slice(0, 30),
    ...allGroups.filter((g) => g.kind === 'near').slice(0, 30),
  ].map(toViewGroup);

  const dupKinds = {
    all: allGroups.length,
    exact: allGroups.filter((g) => g.kind !== 'near').length,
    near: allGroups.filter((g) => g.kind === 'near').length,
  };

  // Экономия: неканонические точные копии можно удалять, почти-клоны — только сверять.
  const dupWasted = (state.dupGroups || []).reduce(
    (acc, g) => {
      acc[g.kind === 'near' ? 'near' : 'exact'] += g.wastedBytes || 0;
      return acc;
    },
    { exact: 0, near: 0 },
  );

  const summary = {
    total: projects.length,
    withGit: projects.filter((p) => p.isGit).length,
    withTests: projects.filter((p) => p.hasTests).length,
    stale60: projects.filter((p) => (p.staleDays || 0) > 60).length,
    dupWastedBytes: dupWasted.exact,
    nearWastedBytes: dupWasted.near,
  };

  // Проекты-дубли по схожести имён (salebot / salebot-backup / salebot-next16 …)
  const byKey = new Map();
  for (const p of projects) {
    const key = normalizeProjectName(p.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const projectDupGroups = [...byKey.entries()]
    .filter(([, ms]) => ms.length > 1)
    .map(([key, ms]) => {
      const sorted = [...ms].sort(
        (a, b) => (b.score || 0) - (a.score || 0) || (b.lastActivityMs || 0) - (a.lastActivityMs || 0),
      );
      return {
        key,
        members: sorted.map((p, i) => ({ name: p.name, stage: p.stage, score: p.score, isCanonical: i === 0 })),
      };
    })
    .sort((a, b) => b.members.length - a.members.length);

  return { scannedAt: state.generatedAt || null, summary, dupKinds, projects, dupGroups, projectDupGroups, log: [] };
}

/** Активные аренды для дашборда: кто, что и сколько осталось. */
export async function buildLeasesView(now = Date.now()) {
  const store = await loadLeases();
  const nameByPath = new Map();
  try {
    const state = await loadState();
    for (const p of state.projects || []) nameByPath.set(path.resolve(p.path), p.name);
  } catch { /* состояния нет — покажем пути */ }
  return activeLeases(store, now)
    .map((l) => ({
      id: l.id,
      projectName: nameByPath.get(path.resolve(l.project)) || path.basename(l.project),
      rel: l.rel,
      owner: l.owner,
      reason: l.reason || '',
      acquiredAt: l.acquiredAt,
      expiresAt: l.expiresAt,
      leftMs: Math.max(0, Date.parse(l.expiresAt) - now),
      whole: l.rel === '.',
    }))
    .sort((a, b) => a.leftMs - b.leftMs);
}

export async function buildConflictsCount() {
  return countConflicts();
}

/* ─────────────────── Настройки и запуск скана из браузера ─────────────────── */

/** Валидация и нормализация присылаемого конфига. Возвращает ошибку или чистый объект. */
export function sanitizeConfigPatch(body) {
  const patch = {};
  const err = (msg) => ({ error: msg });

  if (body.roots !== undefined) {
    if (!Array.isArray(body.roots)) return err('roots должен быть массивом путей');
    const roots = [...new Set(body.roots.map((r) => String(r).trim()).filter(Boolean))];
    if (!roots.length) return err('Нужен хотя бы один корень сканирования');
    patch.roots = roots;
  }
  if (body.ignore !== undefined) {
    if (!Array.isArray(body.ignore)) return err('ignore должен быть массивом строк');
    patch.ignore = body.ignore.map((s) => String(s).trim()).filter(Boolean);
  }
  if (body.ignoreFiles !== undefined) {
    if (!Array.isArray(body.ignoreFiles)) return err('ignoreFiles должен быть массивом строк');
    patch.ignoreFiles = body.ignoreFiles.map((s) => String(s).trim()).filter(Boolean);
  }
  if (body.maxDepth !== undefined) {
    const n = Number(body.maxDepth);
    if (!Number.isInteger(n) || n < 1 || n > 20) return err('maxDepth — целое 1..20');
    patch.maxDepth = n;
  }
  if (body.maxFilesPerProject !== undefined) {
    const n = Number(body.maxFilesPerProject);
    if (!Number.isInteger(n) || n < 100 || n > 500000) return err('maxFilesPerProject — целое 100..500000');
    patch.maxFilesPerProject = n;
  }
  if (body.staleDays !== undefined) {
    if (!Array.isArray(body.staleDays) || body.staleDays.length !== 3
      || !body.staleDays.every((n) => Number.isFinite(Number(n)))) {
      return err('staleDays — три числа, например [30, 60, 180]');
    }
    patch.staleDays = body.staleDays.map(Number);
  }
  if (body.dup !== undefined) {
    const d = body.dup || {};
    patch.dup = {};
    if (d.near !== undefined) patch.dup.near = !!d.near;
    if (d.nearThreshold !== undefined) {
      const n = Number(d.nearThreshold);
      if (!Number.isFinite(n) || n < 0.5 || n > 1) return err('nearThreshold — число 0.5..1');
      patch.dup.nearThreshold = n;
    }
    if (d.minLines !== undefined) {
      const n = Number(d.minLines);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return err('dup.minLines — целое 1..1000');
      patch.dup.minLines = n;
    }
    if (d.minSize !== undefined) {
      const n = Number(d.minSize);
      if (!Number.isInteger(n) || n < 0 || n > 10 * 1024 * 1024) return err('dup.minSize — целое байт 0..10МБ');
      patch.dup.minSize = n;
    }
    if (d.maxSize !== undefined) {
      const n = Number(d.maxSize);
      if (!Number.isInteger(n) || n < 1024 || n > 50 * 1024 * 1024) return err('dup.maxSize — целое байт 1КБ..50МБ');
      patch.dup.maxSize = n;
    }
  }
  if (body.leases !== undefined) {
    const l = body.leases || {};
    patch.leases = {};
    if (l.ttlMinutes !== undefined) {
      const n = Number(l.ttlMinutes);
      if (!Number.isFinite(n) || n < 1 || n > 1440) return err('leases.ttlMinutes — число минут 1..1440');
      patch.leases.ttlMinutes = n;
    }
    if (l.detectWrites !== undefined) patch.leases.detectWrites = !!l.detectWrites;
    if (l.violationCooldownMs !== undefined) {
      const n = Number(l.violationCooldownMs);
      if (!Number.isInteger(n) || n < 0 || n > 3600000) {
        return err('leases.violationCooldownMs — целое миллисекунд 0..3600000');
      }
      patch.leases.violationCooldownMs = n;
    }
  }
  if (body.monetization !== undefined) {
    if (typeof body.monetization !== 'object' || body.monetization === null || Array.isArray(body.monetization)) {
      return err('monetization должен быть объектом { id|путь: { value } }');
    }
    const map = {};
    for (const [key, val] of Object.entries(body.monetization)) {
      if (!key) return err('monetization: ключ (id или путь) не может быть пустым');
      const num = (val && typeof val === 'object') ? Number(val.value) : Number(val);
      if (!Number.isFinite(num) || num < 0 || num > 100) {
        return err(`monetization["${key}"]: value — число 0..100`);
      }
      map[key] = { value: num };
    }
    patch.monetization = map;
  }
  if (body.rating !== undefined) {
    const r = body.rating || {};
    patch.rating = {};
    if (r.weights !== undefined) {
      const w = r.weights || {};
      const wV = Number(w.monetization);
      const wR = Number(w.readiness);
      if (!Number.isFinite(wV) || wV < 0 || wV > 1
        || !Number.isFinite(wR) || wR < 0 || wR > 1) {
        return err('rating.weights — два числа 0..1 (monetization, readiness)');
      }
      if (wV === 0 && wR === 0) return err('rating.weights — оба веса не могут быть нулями');
      patch.rating.weights = { monetization: wV, readiness: wR };
    }
  }
  if (body.score !== undefined) {
    const s = body.score || {};
    if (s.weights !== undefined) {
      if (typeof s.weights !== 'object' || s.weights === null || Array.isArray(s.weights)) {
        return err('score.weights должен быть объектом { компонента: вес }');
      }
      const unknown = Object.keys(s.weights).filter((k) => !(k in PART_MAX));
      if (unknown.length) {
        return err(`score.weights: неизвестные компоненты: ${unknown.join(', ')}. Допустимые: ${Object.keys(PART_MAX).join(', ')}`);
      }
      const w = {};
      for (const [k, val] of Object.entries(s.weights)) {
        const num = Number(val);
        if (!Number.isFinite(num) || num < 0 || num > 100) {
          return err(`score.weights["${k}"] — число 0..100`);
        }
        w[k] = num;
      }
      const sum = Object.values(normalizeScoreWeights(w)).reduce((a, b) => a + b, 0);
      if (sum <= 0) return err('score.weights: сумма весов должна быть больше нуля');
      patch.score = { weights: w };
    }
  }
  if (!Object.keys(patch).length) return err('Пустой патч — нечего сохранять');
  return { patch };
}

/** Состояние фонового скана (один одновременно). */
const scanStatus = { running: false, startedAt: null, error: null };

/**
 * Кандидаты корней для выпадающего списка в настройках: диски и родители
 * текущих корней + подкаталоги первого уровня каждого корня.
 */
export async function folderCandidates() {
  const cfg = await loadConfig();
  const roots = (cfg && Array.isArray(cfg.roots)) ? cfg.roots : [];
  const isIgnored = compileIgnore(cfg ? cfg.ignore : []);
  // Слеш нормализуем к прямому: конфиг хранит пути в этом стиле,
  // иначе выбор из списка создаст дубль корня с обратными слешами.
  const norm = (p) => path.resolve(p).replace(/\\/g, '/');
  const cands = new Set();
  for (const raw of roots) {
    let cur = norm(raw);
    cands.add(cur);
    let parent = path.dirname(cur);
    while (parent !== cur) {
      cands.add(norm(parent));
      cur = norm(parent);
      parent = path.dirname(cur);
    }
    let entries = [];
    try {
      entries = await fsp.readdir(path.resolve(raw), { withFileTypes: true });
    } catch { /* корень не читается */ }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (isIgnored(e.name)) continue;
      cands.add(norm(path.join(path.resolve(raw), e.name)));
    }
  }
  return [...cands].sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Человекочитаемые описания событий для живой ленты. */
export function describeEvent(e) {
  const p = e.payload || {};
  if (e.type === 'scan.completed') {
    const parts = [`${p.projects ?? '?'} проектов`];
    if (p.exactGroups !== undefined) parts.push(`${p.exactGroups} точных + ${p.nearGroups ?? 0} похожих групп`);
    else if (p.dupGroups !== undefined) parts.push(`${p.dupGroups} групп клонов`);
    const secs = p.elapsedMs ? ` за ${(p.elapsedMs / 1000).toFixed(1)} с` : '';
    return `Сканирование завершено: ${parts.join(', ')}${secs}`;
  }
  if (e.type === 'project.activity') {
    // Без аренды автор неизвестен (ОС не сообщает) — так и пишем, чтобы
    // было видно, что атрибуции нет и агенту стоит взять аренду.
    const who = p.owner ? `${p.owner} обновляет ` : 'Изменены файлы (без аренды): ';
    const files = Array.isArray(p.files) ? p.files.filter(Boolean) : [];
    const what = files.length
      ? files.slice(0, 3).join(', ') + (files.length > 3 ? ` +ещё ${files.length - 3}` : '')
      : 'файлы проекта';
    return `${who}${p.project}: ${what} · скор ${p.score ?? '?'} (${p.stage ?? '—'})`;
  }
  if (e.type === 'project.refreshed') {
    const diff = p.scoreBefore !== undefined && p.scoreBefore !== p.score
      ? ` · скор ${p.scoreBefore} → ${p.score}`
      : ` · скор ${p.score ?? '?'} (без изменений)`;
    return `Проект пересчитан: ${p.project}${diff} · стадия ${p.stage ?? '—'}`;
  }
  if (e.type === 'lease.acquired') {
    const target = p.rel === '.' ? `проект ${p.project} целиком` : `${p.project}\\${p.rel}`;
    return `${p.owner} взял аренду: ${target} (до ${p.expiresAt ? new Date(p.expiresAt).toLocaleTimeString('ru-RU') : '?'})`;
  }
  if (e.type === 'lease.released') {
    const target = p.rel === '.' ? `проект ${p.project} целиком` : `${p.project}\\${p.rel}`;
    return `${p.owner} освободил аренду: ${target}`;
  }
  if (e.type === 'lease.blocked') {
    const target = p.rel === '.' ? `проект ${p.project} целиком` : `${p.project}\\${p.rel}`;
    return `Запрос отклонён: ${p.requester} хотел ${target}, но держит ${p.holder}`;
  }
  if (e.type === 'lease.forced') {
    const target = p.rel === '.' ? `проект ${p.project} целиком` : `${p.project}\\${p.rel}`;
    return `Аренда перехвачена: ${p.requester} забрал ${target}`;
  }
  if (e.type === 'lease.violation') {
    const target = p.rel === '.' ? `проект ${p.project} целиком` : `${p.project}\\${p.rel}`;
    if (p.confirmed) {
      return `Запись под чужой арендой: ${p.requester} пишет в ${target}, держит ${p.holder}`;
    }
    return `Файл под арендой изменился: ${target} (держит ${p.holder}, автор неизвестен)`;
  }
  if (e.type === 'agents-md.updated') {
    return `Правила аренд записаны: ${p.file}`;
  }
  if (e.type === 'config.updated') {
    return `Настройки обновлены: ${p.keys}`;
  }
  if (e.type === 'report.generated') {
    return `Отчёт собран: ${p.html || p.md || 'файл'}`;
  }
  if (e.type === 'brief.copied') {
    return 'Сводка сессии скопирована в буфер обмена';
  }
  // Fallback для незнакомых событий: не сырой JSON, а «ключ=значение».
  const keys = Object.keys(p);
  if (!keys.length) return String(e.type);
  const fmt = (v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
  return `${e.type}: ${keys.map((k) => `${k}=${fmt(p[k])}`).join(', ')}`;
}

export async function readLog(limit = 80) {
  try {
    const txt = await fsp.readFile(EVENTS_PATH, 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean).slice(-limit);
    const out = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        out.push({ ts: e.ts, text: describeEvent(e) });
      } catch { /* битая строка — пропускаем */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

/* ─────────────── Сценарии: удаление, отчёт, контекст сессии ─────────────── */

/**
 * Кандидаты на удаление в виде для дашборда.
 * По умолчанию точные клоны: near-копии различаются, удалять их автоматически нельзя.
 */
export function buildCleanupView(state, { kind = 'exact', minBytes = 0, limit = 25 } = {}) {
  if (!state || !Array.isArray(state.projects)) {
    return { kind: 'exact', totalBytes: 0, totalFiles: 0, totalLines: 0, groups: 0, projects: [], wholeProjects: [], nearWastedBytes: 0 };
  }
  const rep = buildCleanupReport(state, { kind, minBytes });
  const project = (r) => ({
    id: r.projectId,
    name: r.name,
    path: r.path,
    wastedBytes: r.wastedBytes,
    wastedLines: r.wastedLines,
    files: r.files,
  });
  const wholeIds = new Set(rep.noCanonicalProjects.map((r) => r.projectId));
  return {
    kind: rep.kind,
    totalBytes: rep.totalBytes,
    totalFiles: rep.totalFiles,
    totalLines: rep.totalLines,
    groups: rep.groups,
    nearWastedBytes: rep.nearWastedBytes,
    projects: rep.projects.slice(0, limit).map((r) => ({ ...project(r), whole: wholeIds.has(r.projectId) })),
    wholeProjects: rep.noCanonicalProjects.slice(0, 15).map(project),
  };
}

/**
 * Бриф ждёт вьюху аренд из buildLeasesView (projectName, leftMs, whole).
 * Сырые записи leases.json приводим к той же форме — иначе бриф печатает
 * `undefined\...` и `NaN мин`.
 */
function normalizeLeaseView(l) {
  if (l.projectName !== undefined && l.leftMs !== undefined) return l;
  return {
    projectName: l.projectName ?? path.basename(l.project || ''),
    rel: l.rel,
    owner: l.owner,
    reason: l.reason || '',
    whole: l.whole ?? l.rel === '.',
    leftMs: l.leftMs ?? (Date.parse(l.expiresAt) - Date.now()),
  };
}

/**
 * Сводка для вставки в новую сессию агента: что болит, что занято, что делать.
 * Формат — markdown, чтобы одинаково годился и для чата, и для файла.
 */
export async function buildBriefText(state, leases, { limitProjects = 10, limitGroups = 5, handoffs: handoffsArg = null } = {}) {
  const now = new Date().toLocaleString('ru-RU');
  if (!state || !Array.isArray(state.projects) || !state.projects.length) {
    return `# Контекст сессии · Панель вайбкодинга\n\nСостояние на ${now}: данных нет — сначала запустите сканирование кнопкой «Обновить данные».\n`;
  }
  const view = buildView(state);
  const L = [];

  // Handoff-пакеты: индексируем по всем ключам, последняя запись побеждает.
  let latestFor = () => null;
  try {
    const handoffs = (handoffsArg !== null && handoffsArg !== undefined) ? handoffsArg : await loadHandoffs();
    if (handoffs && handoffs.length) {
      const byId = new Map();
      const byPath = new Map();
      const byName = new Map();
      for (const h of handoffs) {
        if (h.projectId) byId.set(String(h.projectId), h);
        if (h.projectPath) byPath.set(path.resolve(h.projectPath), h);
        if (h.projectName) byName.set(String(h.projectName).toLowerCase(), h);
      }
      latestFor = (p) => {
        if (p.id && byId.has(String(p.id))) return byId.get(String(p.id));
        if (p.path && byPath.has(path.resolve(p.path))) return byPath.get(path.resolve(p.path));
        if (p.name && byName.has(String(p.name).toLowerCase())) return byName.get(String(p.name).toLowerCase());
        return null;
      };
    }
  } catch { /* журнал handoff ещё не создан */ }

  L.push('# Контекст сессии · Панель вайбкодинга');
  L.push('');
  L.push(`Состояние на ${now} · проектов ${view.projects.length} · `
    + `с git ${view.summary.withGit} · с тестами ${view.summary.withTests} · застой >60д ${view.summary.stale60}`);
  L.push(`Дублей: ${view.dupKinds.all} групп (точных ${view.dupKinds.exact}, похожих ${view.dupKinds.near}) `
    + `· можно освободить ${formatBytes(view.summary.dupWastedBytes)}`);
  L.push('');

  const hot = [...view.projects]
    .filter((p) => (p.flags || []).length)
    .sort((a, b) => (b.flags.length - a.flags.length) || ((a.score || 0) - (b.score || 0)))
    .slice(0, limitProjects);
  L.push('## Требуют решения');
  L.push('');
  if (!hot.length) {
    L.push('Проектов с проблемами нет.');
  } else {
    hot.forEach((p, i) => {
      const flags = (p.flags || []).map((f) => f.text).join('; ');
      const ago = p.lastActivityAt ? ` · активность ${formatAgo(p.lastActivityAt)}` : '';
      L.push(`${i + 1}. \`${p.name}\` — ${p.stage} · скор ${p.score}${ago} · ${flags}`);
      L.push(`   путь: \`${p.path}\``);
      const hf = latestFor(p);
      if (hf) {
        const what = hf.note ? `: ${hf.note}` : ' (без заметки)';
        L.push(`   ↳ последний работал ${hf.owner} (${formatAgo(hf.ts)})${what}`);
      }
    });
  }
  L.push('');

  L.push('## Аренды');
  L.push('');
  if (!leases || !leases.length) {
    L.push('Активных аренд нет — файлы свободны.');
  } else {
    for (const raw of leases) {
      const l = normalizeLeaseView(raw);
      const target = l.whole ? 'проект целиком' : l.rel;
      L.push(`- \`${l.projectName}\\${target}\` — держит ${l.owner} · осталось ${Math.max(0, Math.round(l.leftMs / 60000))} мин`
        + (l.reason ? ` · ${l.reason}` : ''));
    }
  }
  L.push('');

  const groups = (state.dupGroups || []).slice(0, limitGroups);
  if (groups.length) {
    L.push('## Крупнейшие группы клонов');
    L.push('');
    groups.forEach((g, i) => {
      const kind = g.kind === 'near' ? `похожи на ${Math.round((g.similarity ?? 1) * 100)}%` : 'точная копия';
      const waste = g.wastedBytes ? ` · освободит ${formatBytes(g.wastedBytes)}` : '';
      L.push(`${i + 1}. ${g.lines} строк × ${g.members.length}${g.crossProject ? ' · разные проекты' : ''} · ${kind}${waste}`);
      for (const m of (g.members || []).slice(0, 6)) {
        L.push(`   - \`${path.basename(m.projectPath || '')}\\${m.rel}\`${m.isCanonical ? ' ← канон' : ''}`);
      }
      if (g.members.length > 6) L.push(`   - … и ещё ${g.members.length - 6}`);
    });
    L.push('');
  }

  const cleanup = buildCleanupReport(state, { kind: 'exact' });
  if (cleanup.totalFiles) {
    L.push('## Кандидаты на удаление');
    L.push('');
    L.push(`Неканонических точных копий: ${cleanup.totalFiles} файлов на ${formatBytes(cleanup.totalBytes)}. Панель сама ничего не удаляет.`);
    if (cleanup.noCanonicalProjects.length) {
      L.push(`Целиком неуникальные проекты: ${cleanup.noCanonicalProjects.slice(0, 8).map((r) => `\`${r.name}\``).join(', ')}.`);
    }
    L.push('');
  }

  L.push('## Что делать дальше');
  L.push('');
  L.push(hot.length
    ? `1. Взять первый проект из «Требуют решения» (\`${hot[0].name}\`) и закрыть его флаги по одному.`
    : '1. Флагов нет — взять проект с самым низким скором и поднять его до следующей стадии.');
  L.push('2. Перед правками чужого кода брать аренду на файл — так два агента не перетирают работу друг друга.');
  L.push('3. После правок нажать «Обновить данные»: пересчёт одного проекта занимает доли секунды.');
  L.push('');
  return L.join('\n');
}

/** Читает JSON-тело запроса (с лимитом) — для POST-роутов. */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Тело запроса слишком большое'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Тело запроса — не валидный JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Зависимости production-сервера: реальные состояние/конфиг/скан/отчёты.
 * Демо-режим НЕ импортирует и не модифицирует этот объект — он строит
 * свой собственный (см. src/demo/index.js). Production-код не содержит ни
 * одной ветки demo благодаря инъекции deps.
 */
export function productionDeps() {
  return {
    readonly: false,
    disableOpen: false,
    disableWatch: false,
    loadState,
    loadConfig,
    buildLog: () => readLog(),
    buildLeases: () => buildLeasesView(),
    conflictsCount: () => buildConflictsCount(),
    applyConfigPatch: async (body) => {
      const checked = sanitizeConfigPatch(body);
      if (checked.error) throw Object.assign(new Error(checked.error), { status: 400 });
      const current = (await loadConfig()) || {};
      const merged = { ...current, ...checked.patch };
      if (checked.patch.dup) merged.dup = { ...(current.dup || {}), ...checked.patch.dup };
      if (checked.patch.leases) merged.leases = { ...(current.leases || {}), ...checked.patch.leases };
      if (checked.patch.rating) merged.rating = { ...(current.rating || {}), ...checked.patch.rating };
      await saveConfig(merged);
      return { keys: Object.keys(checked.patch).join(', '), config: await loadConfig() };
    },
    startScan: (ctx) => productionStartScan(ctx),
    writeReport: async (state) => writeReports(state),
  };
}

/**
 * Реальный скан: валидируем конфиг, запускаем runScan и транслируем прогресс
 * в SSE. Контракт ctx: { broadcastScanStatus, broadcastLog, refresh }.
 * Возвращает { status, body } — сервер сразу отдаёт 202, а runScan дожигает
 * в фоне и триггерит refresh клиентов через fs.watch (см. /api/events).
 */
async function productionStartScan({ broadcastScanStatus, broadcastLog, refresh }) {
  if (scanStatus.running) {
    return { status: 409, body: { error: 'Сканирование уже идёт' } };
  }
  const cfg = await loadConfig();
  if (!cfg) {
    return { status: 400, body: { error: 'Панель не инициализирована (нет .vibe/config.json)' } };
  }
  scanStatus.running = true;
  scanStatus.startedAt = new Date().toISOString();
  scanStatus.error = null;
  broadcastScanStatus();
  broadcastLog('Сканирование запущено из дашборда');
  let lastSent = 0;
  runScan(cfg, (p) => {
    const now = Date.now();
    if (p.phase === 'git') { broadcastLog('скан: собираю git…'); return; }
    if (now - lastSent < 1000) return;
    lastSent = now;
    const what = p.phase === 'roots' ? 'поиск проектов' : p.phase === 'near' ? `почти-клоны: файлов ${p.files}` : 'сбор метрик';
    broadcastLog(`скан: ${what} · каталогов ${p.visited ?? 0}${p.found !== undefined ? ` · найдено ${p.found}` : ''}`);
  }).then((state) => {
    broadcastLog(`Сканирование завершено: ${state.projects.length} проектов, ${state.dupGroups.length} групп клонов`);
  }).catch((e) => {
    scanStatus.error = String((e && e.message) || e);
    broadcastLog(`Ошибка сканирования: ${scanStatus.error}`);
  }).finally(() => {
    scanStatus.running = false;
    scanStatus.startedAt = null;
    broadcastScanStatus();
  });
  return { status: 202, body: { ok: true } };
}

/** HTTP-сервер дашборда: статика + API состояния/конфига/скана + SSE /api/events. */
export async function serve({ port = 5173, host = '127.0.0.1', deps = productionDeps() } = {}) {
  const sseClients = new Set();
  const broadcastLog = (text) => {
    const ts = new Date().toISOString();
    for (const client of sseClients) client.send('log', { ts, text });
  };
  // Отдельное событие статуса скана — не зависит от изменения state.json,
  // поэтому клиент всегда узнаёт о старте/завершении даже если saveState не случилось.
  const broadcastScanStatus = () => {
    for (const client of sseClients) {
      client.send('scanstatus', {
        running: scanStatus.running, startedAt: scanStatus.startedAt, error: scanStatus.error,
      });
    }
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || host}`);
    try {
      if (u.pathname === '/api/state') {
        const state = await deps.loadState();
        const view = buildView(state);
        view.log = await deps.buildLog();
        view.leases = await deps.buildLeases();
        view.conflictsCount = await deps.conflictsCount();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(view));
        return;
      }

      if (u.pathname === '/api/config') {
        if (req.method === 'POST') {
          if (deps.readonly) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: deps.readonlyMessage || 'Только чтение' }));
            return;
          }
          const body = await readJsonBody(req);
          try {
            const result = await deps.applyConfigPatch(body);
            broadcastLog(`Настройки обновлены: ${result.keys}`);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, config: result.config }));
          } catch (e) {
            const st = e.status || 400;
            res.writeHead(st, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: e.message }));
          }
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({
          config: await loadConfig(),
          panelRoot: PANEL_ROOT,
          scan: { running: scanStatus.running, startedAt: scanStatus.startedAt, error: scanStatus.error },
        }));
        return;
      }

      if (u.pathname === '/api/scan') {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ running: scanStatus.running, startedAt: scanStatus.startedAt, error: scanStatus.error }));
          return;
        }
        if (req.method === 'POST') {
          const r = await deps.startScan({
            broadcastScanStatus,
            broadcastLog,
            refresh: (ts) => { for (const c of sseClients) c.send('refresh', { ts }); },
          });
          res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(r.body));
          return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Метод не поддерживается' }));
        return;
      }

      if (u.pathname === '/api/folders') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ folders: await folderCandidates() }));
        return;
      }

      // Открыть папку проекта в Проводнике (локальный сервер — только 127.0.0.1).
      if (u.pathname === '/api/open') {
        if (deps.disableOpen) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: deps.openDisabledMessage || 'Открытие папок отключено' }));
          return;
        }
        const target = u.searchParams.get('path');
        if (!target || !fs.existsSync(target)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Путь не найден на диске' }));
          return;
        }
        try {
          const child = spawn('explorer.exe', [path.resolve(target)], { detached: true, stdio: 'ignore' });
          child.unref();
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: String((e && e.message) || e) }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (u.pathname === '/api/cleanup') {
        const state = await deps.loadState();
        const kind = u.searchParams.get('kind') === 'near' ? 'near' : 'exact';
        const minBytes = Number(u.searchParams.get('minBytes')) || 0;
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(buildCleanupView(state, { kind, minBytes })));
        return;
      }

      if (u.pathname === '/api/report') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Нужен POST' }));
          return;
        }
        if (deps.readonly) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: deps.reportDisabledMessage || 'Отчёты отключены' }));
          return;
        }
        const state = await deps.loadState();
        if (!state || !Array.isArray(state.projects)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Данных нет — сначала запустите «Обновить данные»' }));
          return;
        }
        const { mdPath, htmlPath } = await writeReports(state);
        const mdName = path.basename(mdPath);
        const htmlName = path.basename(htmlPath);
        try { await appendEvent('report.generated', { md: mdName, html: htmlName }); } catch { /* журнал не критичен */ }
        broadcastLog(`Отчёт собран: ${htmlName}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          mdPath, htmlPath,
          mdUrl: `/reports/${encodeURIComponent(mdName)}`,
          htmlUrl: `/reports/${encodeURIComponent(htmlName)}`,
        }));
        return;
      }

      if (u.pathname === '/api/brief') {
        const state = await deps.loadState();
        const leases = await deps.buildLeases();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ text: await buildBriefText(state, leases) }));
        return;
      }

      // Отчёты лежат в каталоге reports: отдаём их, чтобы кнопка давала открываемую ссылку.
      if (u.pathname.startsWith('/reports/')) {
        const name = path.basename(decodeURIComponent(u.pathname.slice('/reports/'.length)));
        const filePath = path.resolve(REPORTS_DIR, name);
        if (filePath !== path.join(REPORTS_DIR, name) || !filePath.startsWith(REPORTS_DIR + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Forbidden');
          return;
        }
        const data = await fsp.readFile(filePath);
        const type = name.toLowerCase().endsWith('.html')
          ? 'text/html; charset=utf-8'
          : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(data);
        return;
      }

      if (u.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

        let closed = false;
        const send = (event, data) => {
          if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const client = { send };
        sseClients.add(client);
        // Сразу сообщаем новому клиенту текущий статус скана, чтобы
        // «застрявший» бейдж самоисцелился при переподключении/перезагрузке страницы.
        client.send('scanstatus', {
          running: scanStatus.running, startedAt: scanStatus.startedAt, error: scanStatus.error,
        });
        const heartbeat = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);

        // Следим за всем каталогом .vibe: state, leases и события меняются по отдельности,
        // и файл-вотчер не сработал бы, если файла ещё не было при подключении.
        // В демо-режиме наблюдение отключено (нет реального .vibe, данные статичны).
        let vibeWatcher = null;
        let refreshQueued = false;
        if (!deps.disableWatch) {
          try {
            vibeWatcher = fs.watch(VIBE_DIR, { persistent: false }, () => {
              if (refreshQueued) return;
              refreshQueued = true;
              setTimeout(() => {
                refreshQueued = false;
                send('refresh', { ts: new Date().toISOString() });
              }, 300);
            });
          } catch { /* каталога .vibe ещё нет */ }
        }

        const cleanup = () => {
          if (closed) return;
          closed = true;
          sseClients.delete(client);
          clearInterval(heartbeat);
          if (vibeWatcher) { try { vibeWatcher.close(); } catch { /* уже закрыт */ } }
        };
        req.on('close', cleanup);
        req.on('error', cleanup);
        return;
      }

      if (u.pathname === '/' || u.pathname === '/index.html') {
        const html = await fsp.readFile(path.join(WEB_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String((err && err.message) || err));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
