/**
 * Инкрементальное наблюдение за корнями сканирования (основа vibe watch).
 *
 * fs.watch recursive поддерживается на Windows и macOS — там панель и живёт.
 * Изменённые пути отображаются на проекты (длиннейший префикс), события
 * собираются с дебаунсом и обрабатываются по одному проекту за раз.
 *
 * Каждая порода изменений попадает в журнал как project.activity:
 * какие файлы изменены и кто держит аренду — если изменённые файлы под
 * арендой, активность атрибутируется её владельцу. Активность пишется с
 * dedup:false, чтобы правки, не меняющие скор/стадию, оставались в ленте.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compileIgnore } from './config.js';
import { refreshProjectState, appendEvent } from './store.js';
import { loadLeases, activeLeases } from './leases.js';

const normRel = (p) => String(p || '').replace(/\\/g, '/');

/** Длиннейший префикс: проект, которому принадлежит изменённый путь. */
function findOwnerProject(projects, changedPath) {
  const target = path.resolve(changedPath);
  let best = null;
  for (const p of projects) {
    const root = path.resolve(p.path);
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (!best || root.length > path.resolve(best.path).length) best = p;
    }
  }
  return best || null;
}

/**
 * Активные аренды, покрывающие изменённые файлы проекта.
 * Писателя файловая система не сообщает, поэтому возвращаем держателя (holder),
 * а вызывающий помечает событие как неподтверждённое (confirmed:false).
 *
 * Покрытие в обе стороны: аренда на 'docs' относится и к 'docs/x.md', и наоборот.
 * Если изменённый файл неизвестен (поллинг), считаем аренду покрывающей проект.
 *
 * @returns {Promise<Array<{rel: string, holder: string, files: string[]}>>}
 */
export async function leasedFilesFor(projectPath, files, { now = Date.now(), leasesFile } = {}) {
  try {
    const store = await loadLeases(leasesFile);
    const target = path.resolve(projectPath);
    const covers = (leaseRel, changedRel) =>
      leaseRel === '.' || changedRel === leaseRel
      || leaseRel.startsWith(changedRel + '/') || changedRel.startsWith(leaseRel + '/');
    const hits = [];
    for (const l of activeLeases(store, now)) {
      if (path.resolve(l.project) !== target) continue;
      const rels = files.map(normRel);
      const matched = rels.length ? rels.filter((f) => covers(l.rel, f)) : [l.rel];
      if (matched.length) hits.push({ rel: l.rel, holder: l.owner, files: matched });
    }
    return hits;
  } catch {
    return [];
  }
}

/** Дешёвая проверка «изменилось ли»: mtime корня и .git/index (перенос из lib/refresh.mjs). */
function cheapMtime(project) {
  let t = 0;
  try { t = Math.max(t, fs.statSync(project.path).mtimeMs); } catch { /* исчез */ }
  try {
    const gi = path.join(project.path, '.git', 'index');
    t = Math.max(t, fs.statSync(gi).mtimeMs);
  } catch { /* не git или нет index */ }
  return t;
}

/**
 * Смотрит за корнями и пересчитывает затронутые проекты.
 *
 * @param {object} opts
 * @param {object} opts.cfg конфиг панели
 * @param {object} opts.state состояние панели (мутируется refresh'ами)
 * @param {(result: object, meta: {files: string[], owner: string|null}) => void} [opts.onChange]
 * @param {number} [opts.debounceMs]
 * @param {number} [opts.pollMs]
 * @returns {Promise<{close: () => void, stats: {refreshed: number, failed: number}}>}
 */
export async function watchProjects({
  cfg, state, onChange, debounceMs = 1200, pollMs = 5000,
  leasesFile, eventsFile,
}) {
  const isIgnored = compileIgnore(cfg.ignore);
  const watchers = [];
  const stats = { refreshed: 0, failed: 0 };

  let pending = new Map(); // projectPath -> { project, files: Set<string> }
  let timer = null;
  let busy = false;
  let closed = false;

  const schedule = (project, relFile) => {
    const entry = pending.get(project.path) || { project, files: new Set() };
    if (relFile) entry.files.add(normRel(relFile));
    pending.set(project.path, entry);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };

  /** Владелец аренды, покрывающей изменённые файлы проекта (или весь проект).
   *  Покрытие путей в обе стороны: аренда на 'docs' относится и к 'docs/x.md',
   *  и событие про 'docs' относится к аренде 'docs/x.md'. Поллинг не знает
   *  изменённый файл — считаем любую активную аренду проекта (best-effort). */
  const leaseOwnerFor = async (projectPath, files) => {
    try {
      const store = await loadLeases(leasesFile);
      const now = Date.now();
      const target = path.resolve(projectPath);
      const covers = (leaseRel, changedRel) =>
        leaseRel === '.' || changedRel === leaseRel
        || leaseRel.startsWith(changedRel + '/') || changedRel.startsWith(leaseRel + '/');
      const lease = activeLeases(store, now).find((l) =>
        path.resolve(l.project) === target
        && (files.length === 0 || files.some((f) => covers(l.rel, normRel(f)))));
      return lease ? lease.owner : null;
    } catch {
      return null;
    }
  };

  // Дедуп нарушений: без него серия сохранений файла даёт шквал одинаковых событий.
  const lastViolation = new Map();

  const flush = async () => {
    timer = null;
    if (busy || closed) return;
    if (!pending.size) return;
    busy = true;
    try {
      while (pending.size && !closed) {
        const [projectPath, entry] = [...pending.entries()][0];
        pending.delete(projectPath);
        try {
          const result = await refreshProjectState(state, projectPath, cfg);
          if (result) {
            stats.refreshed++;
            const files = [...entry.files].filter(Boolean).slice(0, 10);
            const owner = await leaseOwnerFor(projectPath, files);
            await appendEvent('project.activity', {
              project: result.project.name,
              owner,
              files,
              score: result.project.score,
              stage: result.project.stage,
            }, { dedup: false, filePath: eventsFile });

            // Приоритет 3: файл под чужой арендой изменился. Писателя ОС не
            // сообщает, поэтому событие помечено confirmed:false — держатель
            // аренды мог править и сам. Точный источник (с писателем) — хук.
            if (cfg.leases && cfg.leases.detectWrites !== false) {
              const cooldown = Number(cfg.leases.violationCooldownMs) || 60000;
              const now = Date.now();
              for (const hit of await leasedFilesFor(projectPath, files, { now, leasesFile })) {
                const key = `${projectPath}|${hit.rel}`;
                if (now - (lastViolation.get(key) || 0) < cooldown) continue;
                lastViolation.set(key, now);
                await appendEvent('lease.violation', {
                  project: result.project.name,
                  projectPath,
                  rel: hit.rel,
                  holder: hit.holder,
                  requester: null,
                  confirmed: false,
                  source: 'watch',
                  files: hit.files.slice(0, 10),
                }, { dedup: false, filePath: eventsFile });
              }
            }

            if (onChange) onChange(result, { files, owner });
          }
        } catch {
          stats.failed++;
        }
      }
    } finally {
      busy = false;
      if (pending.size && !closed) timer = setTimeout(() => void flush(), debounceMs);
    }
  };

  for (const root of cfg.roots) {
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename || closed) return;
        const full = path.join(root, filename);
        const rel = path.relative(root, full);
        // Служебные каталоги (node_modules, .git, .vibe…) не триггерят пересчёт.
        const parts = rel.split(/[\\/]+/);
        if (parts.some((p) => isIgnored(p))) return;
        const owner = findOwnerProject(state.projects, full);
        if (!owner) return;
        schedule(owner, path.relative(owner.path, full));
      });
      w.on('error', () => { /* корень исчез — просто перестаём получать события */ });
      watchers.push(w);
    } catch { /* корень недоступен — пропускаем */ }
  }

  // Поллинг-страховка: fs.watch recursive есть не везде (Linux), а коммиты
  // меняют .git/index без движения mtime корня. Опрос дешёвый — это stat'ы.
  const lastPoll = new Map();
  for (const p of state.projects) lastPoll.set(p.path, cheapMtime(p));
  const pollTimer = setInterval(() => {
    if (closed) return;
    for (const p of state.projects) {
      const t = cheapMtime(p);
      if (t > (lastPoll.get(p.path) || 0)) {
        lastPoll.set(p.path, t);
        schedule(p, null);
      }
    }
  }, pollMs);
  watchers.push({ close: () => clearInterval(pollTimer) });

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const w of watchers) {
        try { w.close(); } catch { /* уже закрыт */ }
      }
    },
    stats,
  };
}
