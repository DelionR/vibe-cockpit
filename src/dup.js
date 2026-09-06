/**
 * Поиск почти-дубликатов (near-dup, M2 уровень 2).
 *
 * Перенос из lib/hash.mjs (minhash) плюс LSH-банды для поиска кандидатов:
 * попарные сравнения делаются только внутри бакетов одинаковых полос подписи,
 * поэтому сложность близка к O(n), а не O(n²).
 */
import { readFile } from 'node:fs/promises';

/** Длина minhash-подписи (число перестановок). */
export const SIGNATURE_LENGTH = 48;
/** Размер шингла в токенах. */
export const SHINGLE_K = 5;
/** Файлы с большим числом токенов из near-анализа исключаются. */
export const MAX_SIGN_TOKENS = 40000;
/** Похожесть подписей, начиная с которой файлы считаются почти-клонами. */
export const NEAR_THRESHOLD = 0.85;

const LINE_COMMENT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.cpp', '.h', '.css', '.scss', '.php', '.swift',
]);
const HASH_COMMENT_EXT = new Set(['.py', '.sh', '.ps1', '.yml', '.yaml', '.toml', '.rb', '.rake', '.pl']);

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Нормализация содержимого: снятие комментариев по языку, схлопывание
 * пробелов и пустых строк. Умнее старой normalizeForHash из scanner.js —
 * файлы, отличающиеся только комментариями, теперь дают один хеш.
 */
export function normalizeContent(raw, ext) {
  let s = String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (LINE_COMMENT_EXT.has(ext)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/[^\n]*/g, '');
  } else if (HASH_COMMENT_EXT.has(ext)) {
    s = s.replace(/(^|[ \t])#[^\n]*/g, '');
  } else if (ext === '.html' || ext === '.vue' || ext === '.svelte') {
    s = s.replace(/<!--[\s\S]*?-->/g, '');
  }
  return s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

/**
 * Быстрый эквивалент конкатенации `shingle + '|' + i` из lib/hash.mjs:
 * одна перестановка на строку подписи без аллокаций строк.
 */
function mixRow(base, i) {
  let h = Math.imul(base ^ (i + 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Minhash-подпись текста; null — текст слишком короткий или слишком большой. */
export function minhashSignature(text, k = SHINGLE_K, n = SIGNATURE_LENGTH) {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  if (tokens.length < k * 2 || tokens.length > MAX_SIGN_TOKENS) return null;
  const shingles = new Set();
  for (let i = 0; i <= tokens.length - k; i++) shingles.add(tokens.slice(i, i + k).join(' '));
  const sig = new Array(n).fill(0xffffffff);
  for (const sh of shingles) {
    const base = fnv1a(sh);
    for (let i = 0; i < n; i++) {
      const h = mixRow(base, i);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

/** Оценка похожести двух подписей (доля совпавших строк) — аппроксимация Жаккара. */
export function signatureSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Читает файлы-кандидаты, нормализует и отбирает годные для подписей.
 * @param {Array<{project: string, rel: string, path: string, ext: string, size: number}>} files
 * @returns {Promise<Array<{project, rel, path, ext, size, text, lines}>>}
 */
export async function readCandidates(files, opts = {}) {
  if (!files.length) return [];
  const minLines = opts.minLines ?? 5;
  const texts = new Array(files.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(8, files.length) }, async () => {
    while (idx < files.length) {
      const i = idx++;
      try {
        texts[i] = normalizeContent(await readFile(files[i].path, 'utf8'), files[i].ext);
      } catch {
        texts[i] = null;
      }
    }
  });
  await Promise.all(workers);

  const candidates = [];
  for (let i = 0; i < files.length; i++) {
    const text = texts[i];
    if (text == null || text.length === 0) continue;
    const lines = text.split('\n').length;
    if (lines < minLines) continue;
    candidates.push({ ...files[i], text, lines });
  }
  return candidates;
}

/**
 * Подписи для уже прочитанных кандидатов.
 * @returns {Array<{file: object, sig: number[]}>}
 */
export function signaturesOf(candidates) {
  const entries = [];
  for (const f of candidates) {
    const sig = f.text != null ? minhashSignature(f.text) : null;
    if (sig) entries.push({ file: f, sig });
  }
  return entries;
}

/**
 * Группирует заранее подписанные файлы в near-группы (LSH + union-find).
 * @param {Array<{file: {project, rel, size, lines}, sig: number[]}>} entries
 */
export function nearGroupsFromEntries(entries, opts = {}) {
  const threshold = opts.threshold ?? NEAR_THRESHOLD;
  const bands = opts.bands ?? 16;
  const rows = opts.rows ?? 3;
  const maxBucket = opts.maxBucket ?? 12; // бакеты-шум (шаблонные файлы) не разворачиваем в пары

  // LSH: подпись делится на полосы; совпадение целой полосы — кандидатная пара.
  const buckets = new Map();
  entries.forEach((e, i) => {
    const sig = e.sig;
    for (let b = 0; b < bands; b++) {
      const off = b * rows;
      const key = `${b}|${sig.slice(off, off + rows).join('.')}`;
      const arr = buckets.get(key);
      if (arr) arr.push(i);
      else buckets.set(key, [i]);
    }
  });

  const parent = entries.map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  const seen = new Set();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > maxBucket) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (signatureSimilarity(entries[a].sig, entries[b].sig) >= threshold) union(a, b);
      }
    }
  }

  const clusters = new Map();
  entries.forEach((e, i) => {
    const r = find(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(e);
  });

  const groups = [];
  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue;
    // Канон — член с максимальной суммарной похожестью на остальных.
    let bestI = 0;
    let bestSum = -1;
    for (let i = 0; i < cluster.length; i++) {
      let sum = 0;
      for (let j = 0; j < cluster.length; j++) {
        if (i !== j) sum += signatureSimilarity(cluster[i].sig, cluster[j].sig);
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestI = i;
      }
    }
    const canon = cluster[bestI];
    const members = cluster.map((e) => ({
      project: e.file.project,
      rel: e.file.rel,
      size: e.file.size,
      lines: e.file.lines,
      sim: Number(signatureSimilarity(canon.sig, e.sig).toFixed(3)),
    }));
    const similarity = members.reduce((a, m) => a + m.sim, 0) / members.length;
    const projects = [...new Set(members.map((m) => m.project))];
    groups.push({
      kind: 'near',
      hash: null,
      similarity: Number(similarity.toFixed(3)),
      drift: Number((1 - similarity).toFixed(3)),
      lines: canon.file.lines,
      size: canon.file.size,
      members,
      projectCount: projects.length,
      crossProject: projects.length > 1,
    });
  }
  return groups;
}

/** Обёртка над тремя слоями для уже прочитанных текстов (используется в smoke). */
export function findNearGroups(files, opts = {}) {
  return nearGroupsFromEntries(signaturesOf(files), opts);
}

/**
 * Полный near-анализ: чтение файлов, подписи, группы.
 * Возвращает и группы, и подписи — их кэширует .vibe/signatures.json
 * для инкрементального пересчёта.
 * @param {Array<{project: string, rel: string, path: string, ext: string, size: number}>} files
 */
export async function analyzeNearDups(files, opts = {}) {
  const candidates = await readCandidates(files, opts);
  const entries = signaturesOf(candidates);
  return { groups: nearGroupsFromEntries(entries, opts), entries };
}
