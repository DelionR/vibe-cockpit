export function daysSince(isoOrMs) {
  if (!isoOrMs) return null;
  const ts = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

export function formatAgo(isoOrMs) {
  const d = daysSince(isoOrMs);
  if (d === null) return '—';
  if (d === 0) return 'сегодня';
  if (d === 1) return 'вчера';
  if (d < 30) return `${d} дн. назад`;
  if (d < 365) return `${Math.floor(d / 30)} мес. назад`;
  return `${(d / 365).toFixed(1)} г. назад`;
}

export function formatNum(n) {
  if (n === null || n === undefined) return '—';
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatBytes(n) {
  if (!n) return '0';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9а-яё\-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'project';
}

/** Простой планировщик с ограничением параллелизма. */
export async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}
