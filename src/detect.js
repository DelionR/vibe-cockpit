import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Сильные маркеры: их достаточно, чтобы считать каталог проектом. */
const STRONG_MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'deno.json', 'mix.exs', 'rebar.config', 'CMakeLists.txt',
];

/** Слабые маркеры: нужен хотя бы один сильный либо два слабых. */
const WEAK_MARKERS = [
  'Dockerfile', 'Makefile', 'docker-compose.yml', 'docker-compose.yaml',
  'main.py', 'app.py', 'main.js', 'main.ts', 'main.go', 'main.rs', 'index.html',
];

const SOURCE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'pyw', 'ipynb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb',
  'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp', 'swift', 'dart', 'sh', 'bash',
  'sql', 'css', 'scss', 'less', 'html', 'htm', 'md', 'toml', 'yaml', 'yml', 'json',
]);

export const LANG_BY_EXT = {
  js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', tsx: 'TS', mts: 'TS', cts: 'TS',
  vue: 'Vue', svelte: 'Svelte', py: 'Python', ipynb: 'Python', go: 'Go', rs: 'Rust',
  java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', rb: 'Ruby', php: 'PHP',
  cs: 'C#', cpp: 'C++', cc: 'C++', c: 'C', h: 'C', hpp: 'C++', swift: 'Swift',
  dart: 'Dart', sh: 'Shell', bash: 'Shell', sql: 'SQL',
  css: 'CSS', scss: 'CSS', less: 'CSS', html: 'HTML', htm: 'HTML',
  md: 'Markdown', toml: 'TOML', yaml: 'YAML', yml: 'YAML', json: 'JSON',
};

/** Расширения, считаемые кодом (влияют на LOC и на «ядро реализовано»). */
const CODE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php',
  'cs', 'cpp', 'cc', 'c', 'h', 'hpp', 'swift', 'dart', 'sh', 'bash', 'sql',
]);

export function extOf(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function isSourceExt(ext) {
  return SOURCE_EXT.has(ext);
}

export function isCodeExt(ext) {
  return CODE_EXT.has(ext);
}

export function isMinified(name) {
  return /\.min\.(js|css)$/i.test(name) || /\.(map|lock)$/i.test(name);
}

/** Признаки тестов в имени файла или каталога. */
export function looksLikeTest(relPath) {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  return (
    p.includes('/test/') || p.includes('/tests/') || p.includes('/spec/') || p.includes('/specs/') ||
    p.includes('/__tests__/') || p.startsWith('test/') || p.startsWith('tests/') ||
    /(^|\/)(test_[^/]+|[^/]+_test\.[a-z]+|[^/]+\.test\.[a-z]+|[^/]+\.spec\.[a-z]+|conftest\.py)$/.test(p)
  );
}

/**
 * Служебные имена каталогов, которые не бывают самостоятельным проектом,
 * если находятся внутри уже найденного проекта.
 *
 * Без этого списка `src/lib`, `firmware/src`, `.next/static/chunks`
 * распознаются как отдельные проекты и забивают панель мусором.
 */
const NON_PROJECT_NAMES = new Set([
  'src', 'lib', 'libs', 'app', 'apps', 'cmd', 'pkg', 'pkgs', 'internal',
  'test', 'tests', 'spec', 'specs', '__tests__', 'e2e', 'cypress',
  'doc', 'docs', 'documentation', 'examples', 'example', 'samples', 'demo',
  'scripts', 'script', 'tools', 'utils', 'util', 'helpers', 'helper',
  'common', 'shared', 'core', 'modules', 'components', 'composables',
  'pages', 'views', 'layouts', 'routes', 'api', 'controllers', 'models',
  'services', 'middleware', 'store', 'stores', 'hooks',
  'config', 'configs', 'conf', 'settings', 'migrations',
  'styles', 'css', 'scss', 'assets', 'static', 'public', 'images', 'img',
  'types', 'typings', '@types', 'interfaces',
  'chunks', 'vendor', 'third_party', 'thirdparty', 'external',
  'include', 'inc', 'headers', 'resources', 'res', 'locale', 'locales',
  'i18n', 'translations', 'templates', 'layout', 'partials',
  // Типовые имена подприложений/инструментов одного проекта
  'backend', 'frontend', 'front', 'server', 'client', 'web', 'worker', 'workers',
  'evals', 'eval', 'benchmarks', 'agents', 'skills', 'prompts', 'commands', 'claude',
  // Прошивочные/аппаратные компоненты (аудит субагентами 2026-08-31)
  'firmware', 'stm32', 'inc', 'host', 'hardware', 'rpi', 'vo2maxd', 'wokwi',
  // Групповые контейнеры компонентов
  'mcp-servers', 'adapters', 'prototype', 'extension',
]);

export function isNonProjectName(name) {
  return NON_PROJECT_NAMES.has(String(name || '').toLowerCase());
}

/**
 * Признак самостоятельного проекта у вложенного каталога: README, собственные
 * тесты или достаточно широкий состав файлов. Без него вложенный каталог с
 * манифестом — это модуль/компонент родителя (node_export_worker с
 * `package.json + worker.js`, ESP-IDF `main` с CMakeLists.txt), а не проект:
 * карточка в панели лишь дублировала бы родителя.
 */
const STANDALONE_MIN_ENTRIES = 8;

// Служебные записи, которые раскатывает сама панель (git-снапшоты, правила
// агентов). Они не признак самостоятельности: без них `pi` с .git + AGENTS.md
// + тремя скриптами не выглядела бы проектом.
const SERVICE_ENTRIES = new Set([
  '.git', '.gitignore', '.vibe', '.workbuddy-ai', '.claude',
  'agents.md', 'claude.md', 'gemini.md',
]);

const TEST_DIR_RE = /^(tests?|spec|specs|__tests__|e2e|cypress)$/;
const TEST_FILE_RE = /^(test[_-].+|.+[._]test\.[a-z]+|.+\.spec\.[a-z]+|conftest\.[a-z]+)$/;

function hasStandaloneSignal(lowerNames, count) {
  let own = 0;
  for (const n of lowerNames) if (!SERVICE_ENTRIES.has(n)) own++;
  if (own >= STANDALONE_MIN_ENTRIES) return true;
  for (const n of lowerNames) {
    if (n.startsWith('readme')) return true;
    if (TEST_DIR_RE.test(n) || TEST_FILE_RE.test(n)) return true;
  }
  return false;
}

/**
 * Определяет, является ли каталог проектом.
 *
 * Эвристики «много кода» и «точка входа + код» применяются только если
 * ни один из родительских каталогов ещё не является проектом. Иначе
 * `src/`, `app/` и `lib/` распознаются как отдельные проекты.
 *
 * @param {string[]} entryNames имена непосредственных потомков каталога
 * @param {{parentIsProject?: boolean, dirName?: string, depth?: number}} opts
 */
export function detectProjectKind(entryNames, opts = {}) {
  const lower = new Set(entryNames.map((n) => n.toLowerCase()));
  const strong = STRONG_MARKERS.filter((m) => lower.has(m.toLowerCase()));
  const hasSolution = entryNames.some((n) => /\.(sln|csproj|fsproj|vbproj)$/i.test(n));
  const hasGit = lower.has('.git');
  const nonProject = isNonProjectName(opts.dirName);

  // Служебное имя (src, firmware, host, Inc/Src, mcp-servers…) не бывает
  // самостоятельным проектом — ни внутри уже найденного проекта, ни на
  // глубине ≥2 через цепочку недетектированных контейнеров (иначе
  // структурные папки «протекают» в список проектов). На верхнем уровне
  // (depth 1) имя не блокирует — там каталог сам отвечает за себя.
  if (nonProject && (opts.parentIsProject || (opts.depth ?? 0) >= 2)) {
    return { isProject: false, reason: 'generic-dir-inside-project' };
  }

  if (strong.length > 0 || hasSolution || hasGit) {
    // Вложенный каталог без признаков самостоятельности — модуль родителя, не проект.
    if (opts.parentIsProject && !hasStandaloneSignal(lower, entryNames.length)) {
      return { isProject: false, reason: 'nested-module-inside-project' };
    }
    return { isProject: true, reason: hasGit ? 'git' : 'manifest' };
  }

  const weak = WEAK_MARKERS.filter((m) => lower.has(m.toLowerCase()));

  if (opts.parentIsProject) {
    // Вложенный проект допустим только по слабым маркерам (Dockerfile + Makefile)
    return { isProject: false, reason: weak.length >= 2 ? 'weak-markers' : 'inside-project' };
  }

  if (weak.length >= 2) return { isProject: true, reason: 'weak-markers' };

  const codeFiles = entryNames.filter((n) => {
    const e = extOf(n);
    return CODE_EXT.has(e) && !isMinified(n);
  });

  if (weak.length === 1 && codeFiles.length >= 2) return { isProject: true, reason: 'entry+code' };
  if (codeFiles.length >= 4) return { isProject: true, reason: 'code-only' };

  return { isProject: false, reason: 'none' };
}

/** Определяет стек по маркерам каталога. */
export async function detectStack(dirPath, entryNames) {
  const stack = new Set();
  const lower = new Set(entryNames.map((n) => n.toLowerCase()));

  if (lower.has('package.json')) {
    stack.add('node');
    try {
      const pkg = JSON.parse(await readFile(path.join(dirPath, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react || deps['react-dom']) stack.add('react');
      if (deps.vue) stack.add('vue');
      if (deps.next) stack.add('next');
      if (deps.svelte) stack.add('svelte');
      if (deps.electron) stack.add('electron');
      if (deps.express || deps.fastify || deps.koa) stack.add('server');
      if (deps.typescript) stack.add('typescript');
      if (deps.vitest || deps.jest || deps.mocha) stack.add('tests');
    } catch { /* битый package.json — не критично */ }
  }
  if (lower.has('pyproject.toml') || lower.has('requirements.txt') || lower.has('setup.py') || lower.has('pipfile')) {
    stack.add('python');
  }
  if (lower.has('cargo.toml')) stack.add('rust');
  if (lower.has('go.mod')) stack.add('go');
  if (lower.has('pom.xml') || lower.has('build.gradle') || lower.has('build.gradle.kts')) stack.add('jvm');
  if (lower.has('composer.json')) stack.add('php');
  if (lower.has('gemfile')) stack.add('ruby');
  if (entryNames.some((n) => /\.(csproj|sln|fsproj)$/i.test(n))) stack.add('dotnet');
  if (lower.has('dockerfile') || lower.has('docker-compose.yml') || lower.has('docker-compose.yaml')) stack.add('docker');
  if (entryNames.some((n) => /\.html?$/i.test(n))) stack.add('html');

  return [...stack];
}
