import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCORE_WEIGHTS } from './score.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PANEL_ROOT = path.resolve(here, '..');
export const VIBE_DIR = path.join(PANEL_ROOT, '.vibe');
export const CONFIG_PATH = path.join(VIBE_DIR, 'config.json');
export const STATE_PATH = path.join(VIBE_DIR, 'state.json');
export const EVENTS_PATH = path.join(VIBE_DIR, 'events.jsonl');
export const SIGNATURES_PATH = path.join(VIBE_DIR, 'signatures.json');
export const LEASES_PATH = path.join(VIBE_DIR, 'leases.json');
export const CONFLICTS_PATH = path.join(VIBE_DIR, 'conflicts.jsonl');
export const REPORTS_DIR = path.join(PANEL_ROOT, 'reports');

/**
 * Каталоги, в которые никогда не спускаемся.
 * Поддерживаются маски: `*` в конце (`.next-failed*`) и в начале (`__to_delete__*`).
 */
export const DEFAULT_IGNORE = [
  'node_modules', '.git', '.svn', '.hg',
  'venv', '.venv', 'env', '__pycache__', '.tox', '.eggs', 'site-packages',
  'dist', 'build', 'out', 'target', 'bin', 'obj', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.netlify',
  '.cache', '.turbo', '.parcel-cache', '.angular', '.docusaurus',
  '.yarn', '.pnpm-store', '.nyc_output', 'htmlcov', '.ipynb_checkpoints',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.dart_tool',
  '.idea', '.vscode', '.terraform', 'bower_components', 'vendor',
  '.workbuddy-ai', '.claude', 'Pods',
  // Служебный каталог самой панели: это метаданные, а не код проекта.
  // Манифесты .vibe/project.yaml чужих проектов читаются отдельно, а не обходом.
  '.vibe',
  // Варианты служебных каталогов, которые не покрываются точными именами:
  '_next',                 // результат `next export` (static-сборка)
  '.next-*',               // копии сборки Next.js с суффиксами (.next-auth-validation, .next-payments-p0, …)
  '__to_delete__*',        // помеченные к удалению
  '_pending_delete_*',
  '*.egg-info',
  // Сгенерированные артефакты: забивают дубли и искажают экономию.
  'reports',               // отчёты панели и CI
  'outputs',               // сборочные выводы (seo-пакеты, экспорты)
  '.local',                // локальные данные (mariadb, кэши инструментов)
];

/**
 * Компилирует список ignore в предикат с поддержкой масок `*`.
 * @param {string[]} list
 * @returns {(name: string) => boolean}
 */
export function compileIgnore(list = []) {
  const exact = new Set();
  const patterns = [];
  for (const raw of list) {
    const s = String(raw).toLowerCase();
    if (!s) continue;
    if (s.includes('*')) {
      // экранируем всё, кроме `*`, затем `*` -> `.*`
      const re = s
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      patterns.push(new RegExp(`^${re}$`));
    } else {
      exact.add(s);
    }
  }
  return (name) => {
    const n = String(name).toLowerCase();
    if (exact.has(n)) return true;
    for (const re of patterns) if (re.test(n)) return true;
    return false;
  };
}

/** Файлы, которые не считаем исходным кодом. */
export const DEFAULT_IGNORE_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
  'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'bun.lockb',
];

export function defaultConfig() {
  return {
    schema: 1,
    // Корень сканирования настраивается: переменная окружения VIBE_ROOT,
    // либо `vibe init --root <путь>`. Дефолт — сама папка панели (безопасно:
    // не сканирует родительский каталог пользователя).
    roots: process.env.VIBE_ROOT ? [process.env.VIBE_ROOT] : [PANEL_ROOT],
    ignore: DEFAULT_IGNORE,
    ignoreFiles: DEFAULT_IGNORE_FILES,
    maxDepth: 8,
    maxFilesPerProject: 20000,
    staleDays: [30, 60, 180],
    dup: {
      minSize: 128,
      maxSize: 262144,
      minLines: 5,
    },
    leases: {
      ttlMinutes: 30,
      // Детектор записи под чужой арендой в watch (Приоритет 3).
      // watch не знает писателя, поэтому событие помечено confirmed:false.
      detectWrites: true,
      violationCooldownMs: 60000,
    },
    // Ручные веса ценности проектов: ИСТИННЫЙ источник (офлайн-инструмент не
    // знает реальную выручку). Ключ — id проекта или путь. value — 0..100.
    // Побеждает авто-детект из value.js. Пример:
    //   "vechnomolod": { "value": 100 },
    //   "<YOUR_PROJECTS_DIR>/age-app": { "value": 60 }
    monetization: {},
    // Веса бизнес-приоритета: монетизация доминирует, готовность модулирует.
    rating: {
      weights: { monetization: 0.6, readiness: 0.4 },
    },
    // Веса компонентов readiness-скора. Сумма не обязана быть ровно 100 —
    // скор считается как сумма весов, так что 100 держать желательно.
    // Отсутствующие ключи берутся из DEFAULT_SCORE_WEIGHTS (score.js).
    score: {
      weights: { ...DEFAULT_SCORE_WEIGHTS },
    },
  };
}

export async function ensureVibeDir() {
  await mkdir(VIBE_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });
}

export async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const merged = { ...defaultConfig(), ...cfg };
    // Новые правила из DEFAULT_IGNORE подмешиваются в сохранённый конфиг:
    // иначе уже созданный config.json не получает исправления классификации.
    merged.ignore = [...new Set([...(cfg.ignore || []), ...DEFAULT_IGNORE])];
    return merged;
  } catch {
    return null;
  }
}

export async function saveConfig(cfg) {
  await ensureVibeDir();
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

export async function requireConfig() {
  const cfg = await loadConfig();
  if (!cfg) {
    throw new Error('Панель не инициализирована. Выполните: vibe init');
  }
  return cfg;
}
