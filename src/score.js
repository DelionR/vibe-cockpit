import { daysSince } from './util.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Максимум каждой компоненты в «сырых» баллах. На них опирается формула;
 * веса из конфига задают уже нормализованный вклад (сумма = 100).
 */
export const PART_MAX = {
  idea: 10, scaffold: 20, core: 25, tests: 15, config: 10, deploy: 10, docs: 10,
};

/**
 * Веса компонентов готовности по умолчанию (сумма = 100).
 * Переопределяются через `config.score.weights` — см. `sanitizeConfigPatch`.
 *
 * Исходная раскладка плана (idea 10 / scaffold 20 / core 25 / tests 15 /
 * config 10 / deploy 10 / docs 10) калибровалась 06.09 на 56 проектах:
 *   · core насыщался у 46% проектов (скор превращался в «у кого больше кода»);
 *   · deploy был мёртв — 80% нулей, максимум никто не брал.
 * Поэтому вес кода снижен, тестов — поднят, деплоя — урезан до стимула.
 */
export const DEFAULT_SCORE_WEIGHTS = {
  idea: 10, scaffold: 20, core: 22, tests: 20, config: 10, deploy: 8, docs: 10,
};

/** Пороги насыщения компоненты «ядро»: сколько файлов/строк считать полным ядром. */
export const CORE_SATURATION = { codeFiles: 40, loc: 5000 };

/** Приводит пользовательские веса к полному набору чисел. */
export function normalizeScoreWeights(raw) {
  const out = { ...DEFAULT_SCORE_WEIGHTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(out)) {
    const v = Number(raw[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * Статическая оценка готовности проекта (0–100).
 * Считается только по артефактам на диске: ничего не запускается и не выполняется.
 * @param {object} p проект
 * @param {object} [weights] веса компонентов (сумма нормируется к 100)
 */
export function computeScore(p, weights) {
  const has = p.has || {};
  const stack = p.stack || [];
  const names = (p.names || []).map((n) => n.toLowerCase());
  const codeFiles = p.codeFiles || 0;
  const loc = p.loc || 0;

  // Доли компонент (0..1) — вес применяется ниже, поэтому сырые баллы
  // считаем относительно PART_MAX, а не относительно веса.
  const share = {};

  // Замысел зафиксирован
  share.idea = ((has.readme ? 6 : 0) + (has.spec || has.docs ? 4 : 0)) / PART_MAX.idea;

  // Каркас собирается
  const hasManifest = p.detectedReason === 'manifest' || stack.length > 0;
  share.scaffold = ((hasManifest ? 8 : 0) + (has.lockfile ? 5 : 0) + (codeFiles > 0 ? 7 : 0)) / PART_MAX.scaffold;

  // Ядро реализовано. Пороги насыщения подняты (было 20 файлов / 2000 строк):
  // при старых почти половина портфеля брала максимум и компонента не различала проекты.
  share.core = 0.5 * clamp01(codeFiles / CORE_SATURATION.codeFiles) + 0.5 * clamp01(loc / CORE_SATURATION.loc);

  // Тесты
  share.tests =
    ((has.tests || p.testFiles > 0 ? 8 : 0) +
      (stack.includes('tests') ? 4 : 0) +
      ((p.testFiles || 0) >= 3 ? 3 : 0)) / PART_MAX.tests;

  // Конфигурация и данные
  share.config = ((has.envExample ? 4 : 0) + (has.config ? 3 : 0) + (has.gitignore ? 3 : 0)) / PART_MAX.config;

  // Запускаемость и деплой
  const hasRunScript = names.some((n) => ['makefile', 'procfile', 'scripts', 'start.sh', 'run.sh', 'serve'].includes(n));
  share.deploy = ((has.docker ? 4 : 0) + (has.ci ? 3 : 0) + (hasRunScript ? 3 : 0)) / PART_MAX.deploy;

  // Документация и контекст
  share.docs = ((has.readme ? 5 : 0) + (has.agentContext ? 5 : 0)) / PART_MAX.docs;

  const w = normalizeScoreWeights(weights);
  const parts = {};
  for (const k of Object.keys(PART_MAX)) {
    parts[k] = Math.round((share[k] || 0) * w[k]);
  }

  const base = Object.values(parts).reduce((a, b) => a + b, 0);

  // Штрафы
  const penalties = [];
  const stale = daysSince(p.lastActivityAt);
  if (stale !== null) {
    if (stale > 180) penalties.push({ code: 'stale180', value: -25, reason: `нет активности ${stale} дн.` });
    else if (stale > 120) penalties.push({ code: 'stale120', value: -20, reason: `нет активности ${stale} дн.` });
    else if (stale > 60) penalties.push({ code: 'stale60', value: -15, reason: `нет активности ${stale} дн.` });
  }

  const dupShare = p.dupShare || 0;
  if (dupShare > 0.2) {
    penalties.push({ code: 'dups', value: -10, reason: `${Math.round(dupShare * 100)}% кода — дубли` });
  }

  if (!p.git) {
    penalties.push({ code: 'nogit', value: -5, reason: 'нет git-репозитория' });
  }

  const penaltySum = penalties.reduce((a, b) => a + b.value, 0);
  const score = Math.max(0, Math.min(100, base + penaltySum));

  return { score, base, parts, penalties, stage: stageOf(score) };
}

export function stageOf(score) {
  if (score < 20) return 'S0';
  if (score < 40) return 'S1';
  if (score < 60) return 'S2';
  if (score < 80) return 'S3';
  if (score < 95) return 'S4';
  return 'S5';
}

export const STAGE_LABEL = {
  S0: 'Идея',
  S1: 'Каркас',
  S2: 'Альфа',
  S3: 'Бета',
  S4: 'Готово',
  S5: 'Прод',
};

/** Флаги-проблемы, которые пользователь должен увидеть сразу. */
export function computeFlags(p) {
  const flags = [];
  const stale = daysSince(p.lastActivityAt);
  if (stale !== null && stale > 60) flags.push({ code: 'stale', label: `застой ${stale} дн.` });
  if (!p.git) flags.push({ code: 'nogit', label: 'нет git' });
  else if (p.git && !p.git.remote) flags.push({ code: 'noremote', label: 'нет remote' });
  if (p.git && p.git.uncommitted > 0) flags.push({ code: 'dirty', label: `незакоммичено: ${p.git.uncommitted}` });
  if (!p.has?.readme) flags.push({ code: 'noreadme', label: 'нет README' });
  if ((p.testFiles || 0) === 0) flags.push({ code: 'notests', label: 'нет тестов' });
  if ((p.dupShare || 0) > 0.2) flags.push({ code: 'dups', label: `${Math.round(p.dupShare * 100)}% дублей` });
  if (!p.git && !p.has?.readme && (p.testFiles || 0) === 0) flags.push({ code: 'orphan', label: 'сирота' });
  return flags;
}

/**
 * Приоритет «что требует решения».
 * Чем выше — тем раньше проект должен попасться на глаза.
 */
export function priorityOf(p) {
  const flags = p.flags || [];
  const d = daysSince(p.lastActivityAt);
  const recent = d !== null && d <= 14 ? 15 : 0;
  const stale = d !== null && d > 60 ? Math.min(20, d / 12) : 0;
  return Math.round(flags.length * 12 + (100 - p.score) * 0.5 + recent + stale);
}
