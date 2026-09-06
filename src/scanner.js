import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { detectProjectKind, detectStack, extOf, isCodeExt, isMinified, isSourceExt, looksLikeTest, isNonProjectName } from './detect.js';
import { compileIgnore } from './config.js';
import { analyzeNearDups, normalizeContent, NEAR_THRESHOLD } from './dup.js';

const MAX_READ = 262144; // 256 КБ — выше этого не считаем LOC и не хешируем

/** Расширения, участвующие в поиске клонов (точных и почти-клонов). */
const DUP_EXTENSIONS = [
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'py', 'go', 'rs',
  'java', 'kt', 'rb', 'php', 'cs', 'cpp', 'c', 'h', 'sh', 'sql', 'css', 'html',
];

/** Параметры dup-анализа из конфига с дефолтами. */
function dupOptions(cfg) {
  const d = cfg.dup || {};
  return {
    minSize: d.minSize ?? 128,
    maxSize: d.maxSize ?? MAX_READ,
    minLines: d.minLines ?? 5,
    near: d.near !== false,
    nearThreshold: d.nearThreshold ?? NEAR_THRESHOLD,
    extensions: d.extensions || DUP_EXTENSIONS,
  };
}

function emptyStats() {
  return {
    files: 0,
    codeFiles: 0,
    testFiles: 0,
    loc: 0,
    bytes: 0,
    locByLang: {},
    names: [],
    has: {
      readme: false, docs: false, spec: false, tests: false, ci: false,
      docker: false, envExample: false, config: false, gitignore: false,
      agentContext: false, lockfile: false, git: false, remote: false,
    },
    lastMtimeMs: 0,
    truncated: false,
  };
}

/** Фаза A: найти корни проектов. */
async function findProjectRoots(root, cfg, onProgress) {
  const isIgnored = compileIgnore(cfg.ignore);
  const found = [];
  let visited = 0;

  async function visit(dir, depth, parentIsProject) {
    if (depth > cfg.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited++;
    if (visited % 200 === 0 && onProgress) onProgress({ visited, found: found.length, dir });

    const names = entries.map((e) => e.name);
    const dirName = path.basename(dir);
    const kind = detectProjectKind(names, {
      parentIsProject,
      dirName,
      depth,
    });
    // Корень сканирования — контейнер проектов, а не сам проект: иначе панель
    // с её package.json на верхнем уровне объявляла бы весь корень проектом,
    // а все проекты верхнего уровня — «вложенными» в него.
    const isProject = kind.isProject && depth > 0;
    if (kind.isProject && depth > 0) found.push({ path: dir, reason: kind.reason, names });

    // Флаг накапливается: если проект был найден выше по дереву,
    // вложенные служебные каталоги (`src/lib`, `firmware/src`) не считаются
    // проектами. Структурные каталоги (src, firmware, mcp-servers…) передают
    // контекст «внутри проекта» и сами — их дети не должны протекать через
    // недетектированный контейнер как отдельные проекты.
    const structural = isNonProjectName(dirName);
    const childParentIsProject = parentIsProject || isProject || (structural && depth > 0);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (isIgnored(e.name)) continue;
      await visit(path.join(dir, e.name), depth + 1, childParentIsProject);
    }
  }

  await visit(root, 0, false);
  return { found, visited };
}

/** Фаза B: собрать метрики по файлам и хеши для поиска клонов. */
async function collectMetrics(root, rootMap, cfg, onProgress) {
  const isIgnored = compileIgnore(cfg.ignore);
  const ignoreFiles = new Set((cfg.ignoreFiles || []).map((s) => s.toLowerCase()));
  const dup = dupOptions(cfg);
  const stats = new Map();
  const hashes = new Map(); // hash -> [{project, rel, size, lines}]
  const dupMembers = [];    // все dup-eligible файлы (для near-анализа)
  let visited = 0;

  const get = (p) => {
    let s = stats.get(p);
    if (!s) { s = emptyStats(); stats.set(p, s); }
    return s;
  };

  async function visit(dir, depth, owner) {
    if (depth > cfg.maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited++;
    if (visited % 200 === 0 && onProgress) onProgress({ visited, dir });

    const current = rootMap.has(dir) ? rootMap.get(dir) : owner;

    for (const e of entries) {
      const full = path.join(dir, e.name);

      if (e.isDirectory()) {
        if (isIgnored(e.name)) continue;
        await visit(full, depth + 1, current);
        continue;
      }

      if (!current) continue;
      const st = get(current);
      if (st.files >= cfg.maxFilesPerProject) { st.truncated = true; continue; }

      const lower = e.name.toLowerCase();
      if (ignoreFiles.has(lower) || isMinified(e.name)) continue;

      let size = 0;
      let mtimeMs = 0;
      try {
        const s = await stat(full);
        size = s.size;
        mtimeMs = s.mtimeMs;
      } catch {
        continue;
      }

      st.files++;
      st.bytes += size;
      if (mtimeMs > st.lastMtimeMs) st.lastMtimeMs = mtimeMs;

      const ext = extOf(e.name);
      const rel = path.relative(current, full);

      if (isCodeExt(ext) || isSourceExt(ext)) {
        const isTest = looksLikeTest(rel);
        if (isTest) st.testFiles++;
        if (isCodeExt(ext)) st.codeFiles++;

        if (size > 0 && size <= MAX_READ) {
          try {
            const text = await readFile(full, 'utf8');
            const lang = ext.toUpperCase();
            const lines = text.split('\n').length;
            st.loc += lines;
            st.locByLang[lang] = (st.locByLang[lang] || 0) + lines;
          } catch { /* бинарный файл или нет доступа */ }
        }

        // Хешируем только потенциально осмысленные исходники
        if (dup.extensions.includes(ext) && size >= dup.minSize && size <= dup.maxSize) {
          try {
            const text = await readFile(full, 'utf8');
            const norm = normalizeContent(text, `.${ext}`);
            const normLines = norm.split('\n').length;
            if (normLines >= dup.minLines && norm.length > 0) {
              const h = createHash('sha256').update(norm, 'utf8').digest('hex');
              const member = { project: current, rel, size, lines: normLines };
              if (!hashes.has(h)) hashes.set(h, []);
              hashes.get(h).push(member);
              if (dup.near) {
                dupMembers.push({ project: current, rel, path: full, ext: `.${ext}`, size });
              }
            }
          } catch { /* не текстовый файл */ }
        }
      }
    }
  }

  await visit(root, 0, null);
  return { stats, hashes, dupMembers, visited };
}

/** Обновляет булевы признаки проекта по именам его непосредственных потомков. */
export function applyMarkers(st, names, rootPath) {
  const lower = names.map((n) => n.toLowerCase());
  if (!st.has) st.has = {};

  st.has.readme = lower.some((n) => n.startsWith('readme'));
  st.has.docs = lower.includes('docs') || lower.includes('doc') || lower.includes('documentation');
  st.has.spec = lower.some((n) => /(spec|specs|plan|todo|roadmap|design|тз)/.test(n));
  st.has.tests = lower.some((n) => /(^tests?$|^spec$|^specs$|__tests__|conftest)/.test(n)) || st.testFiles > 0;
  // '.github' — с точкой: без неё GitHub Actions не детектился вовсе
  // (в портфеле 5 проектов с .github, а has.ci был всего у одного).
  st.has.ci = lower.some((n) => ['.github', 'github', 'gitlab-ci.yml', '.gitlab-ci.yml', 'jenkinsfile', 'azure-pipelines.yml', 'circleci'].includes(n));
  st.has.docker = lower.some((n) => n === 'dockerfile' || n.startsWith('docker-compose'));
  st.has.envExample = lower.some((n) => n === '.env.example' || n === '.env.sample' || n === 'env.example');
  st.has.config = lower.some((n) => /^(config|settings|conf)\.(js|ts|json|toml|yaml|yml|py|ini)$/.test(n)) || lower.includes('config');
  st.has.gitignore = lower.includes('.gitignore');
  st.has.agentContext = lower.some((n) => ['agents.md', 'claude.md', '.cursorrules', 'agent_instructions.md', '.windsurfrules'].includes(n));
  // Раньше было /(lock|lockb)$/ — ловило только те имена, что КОНЧАЮТСЯ на lock,
  // и пропускало package-lock.json / pnpm-lock.yaml (21 проект из 56).
  st.has.lockfile = lower.some((n) => /(^|[.\-_])(lock|lockb)($|\.[a-z0-9]+$)/.test(n));
  st.has.git = lower.includes('.git');
  void rootPath;
}

/**
 * Нормализует корень сканирования.
 * На Windows `E:` (буква диска без слэша) — это путь, относительный к текущей
 * папке на диске E, а НЕ корень диска. `path.resolve('E:')` резолвит его в cwd
 * процесса на этом диске (например, папку панели), и вместо всего диска
 * сканируется не то. Чтобы `E:` означал корень диска, добавляем разделитель.
 */
function normalizeRoot(raw) {
  let r = String(raw == null ? '' : raw).trim();
  if (!r) return r;
  if (/^[A-Za-z]:$/.test(r)) r = r + '\\';
  return path.resolve(r);
}

/**
 * Полное сканирование всех корней.
 * @returns {Promise<{projects: Array, dupGroups: Array, stats: object}>}
 */
export async function scan(cfg, onProgress = () => {}) {
  const started = Date.now();
  const allProjects = [];
  const allHashGroups = [];
  const allDupMembers = [];
  let dirsVisited = 0;
  const dup = dupOptions(cfg);

  for (const rawRoot of cfg.roots) {
    const root = normalizeRoot(rawRoot);
    onProgress({ phase: 'roots', root });
    const { found: roots, visited: visitedRoots } = await findProjectRoots(root, cfg, (p) => {
      onProgress({ phase: 'roots', root, ...p });
    });

    const rootMap = new Map();
    for (const r of roots) rootMap.set(r.path, r.path);

    onProgress({ phase: 'metrics', root, projects: roots.length });
    const { stats, hashes, dupMembers, visited: visitedMetrics } = await collectMetrics(root, rootMap, cfg, (p) => {
      onProgress({ phase: 'metrics', root, ...p });
    });

    dirsVisited += visitedRoots + visitedMetrics;
    for (const m of dupMembers) allDupMembers.push(m);

    for (const r of roots) {
      const st = stats.get(r.path) || emptyStats();
      st.names = r.names;
      applyMarkers(st, r.names, r.path);
      const stack = await detectStack(r.path, r.names);
      allProjects.push({
        path: r.path,
        name: path.basename(r.path) || r.path,
        detectedReason: r.reason,
        stack,
        ...st,
      });
    }

    for (const [hash, members] of hashes) {
      if (members.length > 1) allHashGroups.push({ hash, members });
    }
  }

  // Точные клоны: совпадение нормализованного текста (уровень 1)
  const exactGroups = allHashGroups
    .map((g) => {
      const projects = [...new Set(g.members.map((m) => m.project))];
      return {
        kind: 'exact',
        hash: g.hash,
        lines: g.members[0].lines,
        size: g.members[0].size,
        members: g.members,
        projectCount: projects.length,
        crossProject: projects.length > 1,
      };
    });

  // Почти-клоны (уровень 2): minhash-подписи файлов, не попавших в точные группы
  let nearGroups = [];
  let nearEntries = [];
  const nearStarted = Date.now();
  if (dup.near && allDupMembers.length > 0) {
    const exactFiles = new Set();
    for (const g of allHashGroups) {
      for (const m of g.members) exactFiles.add(`${m.project}|${m.rel}`);
    }
    const candidates = allDupMembers.filter((m) => !exactFiles.has(`${m.project}|${m.rel}`));
    onProgress({ phase: 'near', files: candidates.length });
    const near = await analyzeNearDups(candidates, { threshold: dup.nearThreshold, minLines: dup.minLines });
    nearGroups = near.groups;
    // Подписи кэшируются (.vibe/signatures.json) — на них опирается инкрементальный refresh.
    nearEntries = near.entries;
  }
  const nearMs = Date.now() - nearStarted;

  // Единый список групп: вес = копий × строк, похожие со скидкой на расхождение
  const weight = (g) => g.members.length * g.lines * (g.kind === 'near' ? (g.similarity ?? 1) : 1);
  const dupGroups = [...exactGroups, ...nearGroups].sort((a, b) => weight(b) - weight(a));

  return {
    projects: allProjects,
    dupGroups,
    nearSignatures: nearEntries,
    stats: {
      dirsVisited,
      projectsFound: allProjects.length,
      dupGroupsFound: dupGroups.length,
      exactGroupsFound: exactGroups.length,
      nearGroupsFound: nearGroups.length,
      nearDupMs: nearMs,
      elapsedMs: Date.now() - started,
    },
  };
}

/**
 * Пересчёт метрик одного проекта (для vibe refresh / vibe watch).
 * Возвращает raw-проект в формате scan() плюс Map хешей его файлов
 * для пересборки групп клонов.
 */
export async function collectProjectMetrics(projectPath, cfg) {
  // Нормализуем (см. normalizeRoot): `E:` → корень диска, а не cwd на диске.
  const normPath = normalizeRoot(projectPath);
  // Вложенные проекты внутри normPath владеют своими файлами — ищем их тоже,
  // иначе refresh приписал бы их родителю (в полном скане они отдельные проекты).
  const { found } = await findProjectRoots(normPath, cfg);
  const rootMap = new Map();
  for (const r of found) rootMap.set(r.path, r.path);
  if (!rootMap.has(normPath)) rootMap.set(normPath, normPath);

  const { stats, hashes, dupMembers } = await collectMetrics(normPath, rootMap, cfg);
  const st = stats.get(normPath) || emptyStats();

  let names = [];
  try {
    names = (await readdir(normPath, { withFileTypes: true })).map((e) => e.name);
  } catch { /* каталог стал нечитаемым */ }
  st.names = names;
  applyMarkers(st, names, normPath);
  const stack = await detectStack(normPath, names);

  return {
    path: normPath,
    name: path.basename(projectPath) || projectPath,
    detectedReason: 'refresh',
    stack,
    ...st,
    hashes,
    // Для инкрементального near-пересчёта: dup-eligible файлы с путями.
    dupMembers,
  };
}
