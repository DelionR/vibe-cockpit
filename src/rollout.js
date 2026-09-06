/**
 * Отбор проектов для раскатки правил агентов (`vibe agents-md --active`).
 *
 * Чистая функция: на вход — проекты из `state.json`, на выход — куда писать
 * и что пропустить с причиной. Диска не касается, время передаётся параметром.
 *
 * Логика отбора:
 * 1. не корень сканирования — это контейнер, а не проект;
 * 2. не бэкап/копия/мусор по имени или пути;
 * 3. не застаревший (порог `maxIdleDays`);
 * 4. не клон: считаем не «долю строк в дублях», а долю строк, где каноном
 *    назначен другой проект (порог `maxForeignDup`). Разница принципиальная:
 *    у живого проекта вроде salebot копий много и dupShare = 1.0, но он сам
 *    источник. Клон же отдают каноном почти всё — 0.97…1.00.
 *    На практике живые источники дают 0.6…0.8, клоны — 0.97…1.00.
 * 5. не вложенный в другой отобранный проект: агенты ищут файл инструкций
 *    вверх по дереву каталогов, поэтому родительский AGENTS.md покрывает ребёнка.
 *    Иначе получим десятки лишних файлов внутри одного дерева.
 */

/** Имена и пути, в которые правила писать не надо. */
const JUNK_PATTERNS = [
  /(^|[-_])backup([-_]|$)/i,
  /-consolidation-\d{8}/i,
  /-offline-\d{8}/i,
  /unfinished/i,
  /_source_copy$/i,
  /(^|[-_])cop(y|ies)([-_]|$)/i,
  /clean_dist/i,
  /^_/,
];

/** Каталоги, целиком состоящие из мусора и промежуточных копий. */
const JUNK_DIRS = [
  /[\\/](_audit_tmp|_staging|_tmp|_trash|node_modules|\.git)[\\/]/i,
];

export const ROLLOUT_DEFAULTS = { maxIdleDays: 14, maxForeignDup: 0.9 };

/**
 * Доля строк проекта в группах клонов, где каноном назначен ДРУГОЙ проект.
 * 0 — проект сам источник всех своих копий, 1 — сплошной клон.
 *
 * Суммируем по вхождениям в группы, а не по `project.loc`: один файл попадает
 * и в exact-, и в near-группу, поэтому дублированные строки могут превышать loc
 * (у content-engine 393 тыс. дубль-строк при 123 тыс. loc).
 *
 * @returns {Map<string, {foreign: number, total: number, share: number}>}
 */
export function foreignDupShare(groups) {
  const acc = new Map();
  for (const group of groups || []) {
    for (const member of group.members || []) {
      const id = member.projectId;
      if (!id) continue;
      const item = acc.get(id) || { foreign: 0, total: 0 };
      const lines = member.lines || 0;
      item.total += lines;
      if (!member.isCanonical) item.foreign += lines;
      acc.set(id, item);
    }
  }
  for (const item of acc.values()) {
    item.share = item.total > 0 ? item.foreign / item.total : 0;
  }
  return acc;
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isJunk(name, dir) {
  if (JUNK_PATTERNS.some((re) => re.test(name))) return true;
  return JUNK_DIRS.some((re) => re.test(dir));
}

function idleDaysOf(project, now) {
  const raw = project?.lastActivityAt;
  if (!raw) return null;
  const ts = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((now - ts) / 86400000);
}

/**
 * @param {Array} projects проекты из `state.projects`
 * @param {{maxIdleDays?: number, maxForeignDup?: number, roots?: string[], dupGroups?: Array, now?: number}} opts
 * @returns {{targets: Array<{project: object, path: string, idleDays: number|null}>, rejected: Array<{name: string, path: string, reason: string}>}}
 */
export function pickRolloutTargets(projects, opts = {}) {
  const {
    maxIdleDays = ROLLOUT_DEFAULTS.maxIdleDays,
    maxForeignDup = ROLLOUT_DEFAULTS.maxForeignDup,
    roots = [],
    dupGroups = [],
    now = Date.now(),
  } = opts;

  const rootSet = new Set(roots.map(normalizePath).filter(Boolean));
  const foreignMap = foreignDupShare(dupGroups);
  const rejected = [];
  const kept = [];

  for (const project of projects || []) {
    const dir = normalizePath(project.path);
    const idleDays = idleDaysOf(project, now);
    const foreign = foreignMap.get(project.id);
    let reason = null;

    if (rootSet.has(dir)) reason = 'корень сканирования';
    else if (isJunk(project.name || '', project.path || '')) reason = 'бэкап, копия или мусор';
    else if (idleDays !== null && idleDays > maxIdleDays) reason = `застой ${idleDays} дн.`;
    else if (foreign && foreign.share > maxForeignDup) {
      reason = `клон: ${Math.round(foreign.share * 100)}% строк — чужие копии`;
    }

    if (reason) {
      rejected.push({ name: project.name, path: project.path, reason });
      continue;
    }
    kept.push({ project, path: dir, idleDays });
  }

  // Вложенные проекты: от короткого пути к длинному, первый совпавший — родитель.
  const byLength = kept.slice().sort((a, b) => a.path.length - b.path.length);
  const targets = [];
  for (const item of kept) {
    const parent = byLength.find(
      (other) => other !== item
        && item.path.length > other.path.length
        && item.path.startsWith(`${other.path}/`),
    );
    if (parent) {
      rejected.push({
        name: item.project.name,
        path: item.project.path,
        reason: `внутри проекта «${parent.project.name}»`,
      });
    } else {
      targets.push(item);
    }
  }

  targets.sort(
    (a, b) => (a.idleDays ?? 999) - (b.idleDays ?? 999)
      || String(a.project.name).localeCompare(String(b.project.name), 'ru'),
  );
  rejected.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));

  return { targets, rejected };
}
