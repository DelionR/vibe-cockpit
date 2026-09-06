/**
 * Ось монетизации/ценности и итоговый бизнес-приоритет проекта.
 *
 * Зачем отдельно от SCORE:
 *   computeScore (score.js) меряет ТЕХНИЧЕСКУЮ ГОТОВНОСТЬ по артефактам на диске
 *   (idea/scaffold/core/tests/config/deploy/docs). Монетизация — это бизнес-ось,
 *   ортогональная готовности: ранний проект может быть ключевым коммерческим
 *   активом, а зрелый — вне бизнеса. Смешивать их в одном числе 0–100 ломает
 *   семантику стадий S0–S5 и двойного счёта не убирает. Поэтому здесь вторая ось.
 *
 * Источники сигнала (офлайн, без сети):
 *   - авто: платёжный SDK/шлюз в имени файла или стеке, страница/описание цен,
 *     признак «выложен и работает» (remote + docker/ci), коммерческий замысел в имени;
 *   - ручной вес ценности из config.monetization[id|path].value — ИСТИННЫЙ источник,
 *     т.к. реальную выручку с диска не прочитать. Ручной вес побеждает авто-сигнал.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));

// Платёжные интеграции — сильнейший авто-сигнал «здесь принимают деньги».
const PAYMENT_SDK = [
  'stripe', 'paddle', 'yookassa', 'robokassa', 'lemonsqueezy', 'shopify',
  'checkout', 'pay', 'merchant', 'liqpay', 'tinkoff', 'sber', 'юкасса', 'робокасса',
];

// Маркеры страницы цен / коммерческого описания.
const PRICING_HINTS = [
  'pricing', 'price', 'tariff', 'тариф', 'цена', 'купить', 'buy', 'оплат',
  'подписк', 'subscription', 'платн', 'shop', 'store', 'магазин', 'saas',
  'commercial', 'консультац', 'consult', 'продаж',
];

// Коммерческий замысел, считываемый прямо из названия проекта.
const COMMERCIAL_NAME = [
  'shop', 'store', 'sale', 'pay', 'market', 'commerce', 'saas', 'monetiz',
  'age', 'health', 'clinic', 'consult', 'продаж', 'магазин', 'магазин',
];

/** Тир ценности (используется для бейджа и матрицы). */
export const VALUE_TIERS = [
  { min: 80, code: 'M3', label: 'Продаёт' },
  { min: 55, code: 'M2', label: 'Монетизируется' },
  { min: 30, code: 'M1', label: 'Идея на продажу' },
  { min: 0, code: 'M0', label: 'Вне бизнеса' },
];

export function valueTier(v) {
  const n = clamp100(v);
  return VALUE_TIERS.find((t) => n >= t.min) || VALUE_TIERS[VALUE_TIERS.length - 1];
}

/**
 * Авто-детект монетизационных сигналов из уже собранных полей проекта.
 * Возвращает { value: 0–100, signals: [{code,label,weight}] }.
 * Это только ПОДСКАЗКА: офлайн-инструмент не знает реальную выручку.
 */
export function detectMonetizationSignal(p) {
  const has = p.has || {};
  const stack = (p.stack || []).map((s) => String(s).toLowerCase());
  const names = (p.names || []).map((n) => String(n).toLowerCase());
  const all = [...stack, ...names];
  const signals = [];

  if (all.some((s) => PAYMENT_SDK.some((k) => s.includes(k)))) {
    signals.push({ code: 'payment', label: 'Платёжный SDK/шлюз', weight: 40 });
  }
  if (names.some((n) => PRICING_HINTS.some((k) => n.includes(k))) || has.readme || has.agentContext) {
    signals.push({ code: 'pricing', label: 'Страница/описание ценности', weight: 25 });
  }
  const shipped = !!(has.docker || has.ci) && !!(p.git && p.git.remote);
  if (shipped) {
    signals.push({ code: 'shipped', label: 'Выложен и работает (docker/ci + remote)', weight: 15 });
  }
  if (COMMERCIAL_NAME.some((k) => String(p.name || '').toLowerCase().includes(k))) {
    signals.push({ code: 'intent', label: 'Коммерческий замысел в названии', weight: 10 });
  }

  const value = Math.min(100, signals.reduce((a, s) => a + s.weight, 0));
  return { value, signals };
}

/** Ручной вес ценности из config.monetization (по id, затем по пути). null, если не задан. */
export function manualValue(p, cfg) {
  const map = (cfg && cfg.monetization) || {};
  const byId = map[p.id];
  if (byId != null) return Number(byId.value != null ? byId.value : byId);
  const byPath = map[p.path];
  if (byPath != null) return Number(byPath.value != null ? byPath.value : byPath);
  return null;
}

/**
 * Итоговая ценность 0–100.
 * Ручной вес (config.monetization) побеждает авто-сигнал; иначе авто-детект.
 */
export function computeValue(p, cfg) {
  const m = manualValue(p, cfg);
  if (m != null && Number.isFinite(m)) {
    return { value: clamp100(m), source: 'manual', signals: [] };
  }
  const auto = detectMonetizationSignal(p);
  return { value: auto.value, source: 'auto', signals: auto.signals };
}

/**
 * Итоговый бизнес-приоритет 0–100 — то, что Роман просил как «приоритетный критерий».
 *
 * Монетизация доминирует (wV > wR), но готовность её МОДУЛИРУЕТ: чистая «идея с
 * лендингом» (V=100, R=0) не должна обгонять готовый денежный продукт (V=80, R=90).
 * Формула — нормированная взвешенная сумма двух осей:
 *   P = 100 * (wV·V/100 + wR·R/100) / (wV + wR)
 * Веса берутся из config.rating.weights (по умолчанию 0.6 / 0.4).
 */
export function computeValuePriority(p, cfg) {
  const r = (cfg && cfg.rating) || {};
  const w = r.weights || { monetization: 0.6, readiness: 0.4 };
  const wV = clamp01(w.monetization != null ? w.monetization : 0.6);
  const wR = clamp01(w.readiness != null ? w.readiness : 0.4);
  const sum = wV + wR || 1;
  const V = (p.value || 0) / 100;
  const R = (p.score || 0) / 100;
  return Math.round(100 * (wV * V + wR * R) / sum);
}
