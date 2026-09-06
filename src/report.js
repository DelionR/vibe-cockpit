import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REPORTS_DIR, ensureVibeDir } from './config.js';
import { STAGE_LABEL } from './score.js';
import { buildCleanupReport } from './store.js';
import { formatAgo, formatBytes, formatNum } from './util.js';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function stageCounts(projects) {
  const c = { S0: 0, S1: 0, S2: 0, S3: 0, S4: 0, S5: 0 };
  for (const p of projects) c[p.stage] = (c[p.stage] || 0) + 1;
  return c;
}

function topLang(locByLang, n = 3) {
  return Object.entries(locByLang || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k)
    .join(', ');
}

function dupKindStats(dupGroups) {
  const stats = { exact: 0, near: 0 };
  for (const g of dupGroups) stats[g.kind === 'near' ? 'near' : 'exact']++;
  return stats;
}

/** Время полного цикла (скан + git), если cmdScan успел дописать totalMs. */
function scanSeconds(scan) {
  const ms = (scan && (scan.totalMs ?? scan.elapsedMs)) || 0;
  return (ms / 1000).toFixed(1);
}

/* ─────────────────────────── Markdown ─────────────────────────── */

export function renderMarkdown(state) {
  const { projects, dupGroups, scan, roots } = state;
  const counts = stageCounts(projects);
  const sorted = [...projects].sort((a, b) => b.priority - a.priority);
  const crossDups = dupGroups.filter((g) => g.crossProject);
  const dupLinesTotal = projects.reduce((a, p) => a + (p.dupLines || 0), 0);

  const L = [];
  L.push('# Инвентаризация проектов');
  L.push('');
  L.push(`**Сгенерировано:** ${new Date(state.generatedAt).toLocaleString('ru-RU')}  `);
  L.push(`**Корни:** ${roots.map((r) => `\`${r}\``).join(', ')}  `);
  L.push(`**Проектов найдено:** ${projects.length} · **просмотрено каталогов:** ${formatNum(scan.dirsVisited)} · **время:** ${scanSeconds(scan)} с`);
  L.push('');

  L.push('## Сводка по стадиям');
  L.push('');
  L.push('| Стадия | Смысл | Проектов |');
  L.push('|---|---|---:|');
  for (const s of ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']) {
    L.push(`| ${s} ${STAGE_LABEL[s]} | ${STAGE_LABEL[s]} | ${counts[s] || 0} |`);
  }
  L.push('');

  L.push('## Что требует решения');
  L.push('');
  L.push('Отсортировано по приоритету: проблемы, низкий скор, недавняя или, наоборот, давно забытая активность.');
  L.push('');
  L.push('| # | Проект | Стадия | Скор | LOC | Активность | Проблемы |');
  L.push('|---:|---|---|---:|---:|---|---|');
  sorted.slice(0, 25).forEach((p, i) => {
    const flags = p.flags.map((f) => f.label).join('; ') || '—';
    L.push(`| ${i + 1} | \`${p.name}\` | ${p.stage} | ${p.score} | ${formatNum(p.loc)} | ${formatAgo(p.lastActivityAt)} | ${flags} |`);
  });
  L.push('');

  L.push('## Все проекты');
  L.push('');
  L.push('| Проект | Стадия | Скор | LOC | Файлов | Тестов | Активность | Стек | Путь |');
  L.push('|---|---|---:|---:|---:|---:|---|---|---|');
  [...projects]
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      L.push(
        `| \`${p.name}\` | ${p.stage} | ${p.score} | ${formatNum(p.loc)} | ${formatNum(p.files)} | ${p.testFiles} | ${formatAgo(p.lastActivityAt)} | ${topLang(p.locByLang) || p.stack.join(', ') || '—'} | \`${p.path}\` |`,
      );
    });
  L.push('');

  L.push('## Дубликаты');
  L.push('');
  const kinds = dupKindStats(dupGroups);
  const crossExact = dupGroups.filter((g) => g.kind !== 'near' && g.crossProject).length;
  const crossNear = dupGroups.filter((g) => g.kind === 'near' && g.crossProject).length;
  L.push(`Групп клонов: **${dupGroups.length}** — точных **${kinds.exact}** (межпроектных **${crossExact}**), похожих **${kinds.near}** (межпроектных **${crossNear}**). Дублированных строк: **${formatNum(dupLinesTotal)}**.`);
  L.push('');
  L.push('_Уровень 1 — точные клоны: совпадение после нормализации пробелов, переводов строк и комментариев. Уровень 2 — похожие файлы: minhash-подписи, похожесть ≥ 85%._');
  L.push('');

  const shown = crossDups.length ? crossDups : dupGroups;
  const shownLabel = crossDups.length ? 'межпроектные' : 'все';
  L.push(`### Топ-30 (${shownLabel})`);
  L.push('');
  shown.slice(0, 30).forEach((g, i) => {
    const kindTag = g.kind === 'near'
      ? ` · похожи на ${Math.round((g.similarity ?? 1) * 100)}%`
      : ' · точная копия';
    const waste = g.wastedBytes ? ` · освободит ${formatBytes(g.wastedBytes)}` : '';
    L.push(`**${i + 1}. ${g.lines} строк × ${g.members.length} копии${kindTag}${waste}**`);
    L.push('');
    for (const m of g.members.slice(0, 8)) {
      const sim = m.sim != null && g.kind === 'near' ? ` (${Math.round(m.sim * 100)}%)` : '';
      const canon = m.isCanonical ? ' ← канон' : ' ← копия';
      L.push(`- \`${m.projectPath}\\${m.rel}\`${sim}${canon}`);
    }
    if (g.members.length > 8) L.push(`- … и ещё ${g.members.length - 8}`);
    L.push('');
  });

  // Кандидаты на удаление: только точные клоны (near-копии удалять нельзя).
  const cleanup = buildCleanupReport(state, { kind: 'exact' });
  L.push('## Кандидаты на удаление');
  L.push('');
  if (!cleanup.totalFiles) {
    L.push('Неканонических точных копий нет — освобождать нечего.');
    L.push('');
  } else {
    L.push(`Удаление неканонических копий точных клонов освободит **${formatBytes(cleanup.totalBytes)}** (${formatNum(cleanup.totalFiles)} файлов, ${formatNum(cleanup.totalLines)} строк). Панель ничего не удаляет сама — решения за тобой.`);
    L.push('');
    if (cleanup.noCanonicalProjects.length) {
      L.push('**Целиком неуникальные проекты** (ни одна их копия не является каноном):');
      L.push('');
      for (const r of cleanup.noCanonicalProjects.slice(0, 10)) {
        L.push(`- \`${r.name}\` — ${formatBytes(r.wastedBytes)} в ${formatNum(r.files)} файлах`);
      }
      L.push('');
    }
    L.push('| Проект | Освободится | Файлов | Строк |');
    L.push('|---|---:|---:|---:|');
    cleanup.projects.slice(0, 15).forEach((r) => {
      L.push(`| \`${r.name}\` | ${formatBytes(r.wastedBytes)} | ${formatNum(r.files)} | ${formatNum(r.wastedLines)} |`);
    });
    L.push('');
    if (cleanup.nearWastedBytes > 0) {
      L.push(`_Плюс почти-дубли на ${formatBytes(cleanup.nearWastedBytes)} — их удалять можно только после сверки вручную._`);
      L.push('');
    }
  }

  return L.join('\n');
}

/* ─────────────────────────── HTML ─────────────────────────── */

export function renderHtml(state) {
  const { projects, dupGroups, scan, roots } = state;
  const counts = stageCounts(projects);
  const sorted = [...projects].sort((a, b) => b.priority - a.priority);
  const crossDups = dupGroups.filter((g) => g.crossProject);
  const crossExact = crossDups.filter((g) => g.kind !== 'near').length;
  const shown = crossDups.length ? crossDups : dupGroups;
  const exactWasted = dupGroups
    .filter((g) => g.kind !== 'near')
    .reduce((a, g) => a + (g.wastedBytes || 0), 0);
  const cleanup = buildCleanupReport(state, { kind: 'exact' });

  const stageBar = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5']
    .map((s) => {
      const n = counts[s] || 0;
      const pct = projects.length ? (n / projects.length) * 100 : 0;
      return `<div class="stage-seg stage-${s}" style="width:${pct}%" title="${s} ${STAGE_LABEL[s]}: ${n}"></div>`;
    })
    .join('');

  const cards = sorted
    .map((p) => {
      const flags = p.flags.map((f) => `<span class="chip chip-${f.code}">${esc(f.label)}</span>`).join('');
      const pens = (p.scorePenalties || [])
        .map((x) => `<li>${esc(x.reason)} <b>${x.value}</b></li>`)
        .join('');
      return `<article class="card">
  <header>
    <div class="card-title">${esc(p.name)}</div>
    <div class="stage-badge stage-${p.stage}">${p.stage} · ${STAGE_LABEL[p.stage]}</div>
  </header>
  <div class="score-row">
    <div class="score-bar"><div class="score-fill stage-${p.stage}" style="width:${p.score}%"></div></div>
    <div class="score-num">${p.score}</div>
  </div>
  <div class="metrics">
    <span>LOC <b>${formatNum(p.loc)}</b></span>
    <span>файлов <b>${formatNum(p.files)}</b></span>
    <span>тестов <b>${p.testFiles}</b></span>
    <span>активность <b>${formatAgo(p.lastActivityAt)}</b></span>
  </div>
  <div class="stack">${esc((p.stack || []).join(' · ') || topLang(p.locByLang) || 'стек не определён')}</div>
  <div class="chips">${flags || '<span class="chip chip-ok">проблем не найдено</span>'}</div>
  ${p.dupShare > 0.05 ? `<div class="dup-line">Дублей: ${Math.round(p.dupShare * 100)}% строк</div>` : ''}
  ${pens ? `<ul class="penalties">${pens}</ul>` : ''}
  <div class="path">${esc(p.path)}</div>
</article>`;
    })
    .join('\n');

  const dupCards = shown
    .slice(0, 40)
    .map((g, i) => {
      const items = g.members
        .slice(0, 10)
        .map((m) => {
          const sim = m.sim != null && g.kind === 'near' ? ` <span class="dup-sim">${Math.round(m.sim * 100)}%</span>` : '';
          const role = g.kind !== 'near' ? (m.isCanonical ? ' <span class="dup-sim">← канон</span>' : ' <span class="dup-sim">копия</span>') : '';
          return `<li><span class="dup-proj">${esc(path.basename(m.projectPath))}</span><code>${esc(m.rel)}</code>${sim}${role}</li>`;
        })
        .join('');
      const kindChip = g.kind === 'near'
        ? `<span class="chip chip-near">похожи на ${Math.round((g.similarity ?? 1) * 100)}%</span>`
        : '<span class="chip chip-exact">точная копия</span>';
      const waste = g.kind !== 'near' && g.wastedBytes ? ` <span class="chip chip-waste">освободит ${formatBytes(g.wastedBytes)}</span>` : '';
      return `<article class="dup-card">
  <div class="dup-head"><b>${i + 1}.</b> ${g.lines} строк · ${g.members.length} копии${g.crossProject ? ' · <span class="chip chip-dups">между проектами</span>' : ''} ${kindChip}${waste}</div>
  <ul>${items}</ul>
  ${g.members.length > 10 ? `<div class="dup-more">… и ещё ${g.members.length - 10}</div>` : ''}
</article>`;
    })
    .join('\n');

  const cleanupRows = cleanup.projects
    .slice(0, 12)
    .map((r) => `<tr><td><code>${esc(r.name)}</code></td><td>${formatBytes(r.wastedBytes)}</td><td>${formatNum(r.files)}</td><td>${cleanup.noCanonicalProjects.includes(r) ? '<span class="chip chip-orphan">целиком</span>' : '<span class="chip">частично</span>'}</td></tr>`)
    .join('');
  const cleanupSection = !cleanup.totalFiles
    ? '<div class="sub">Неканонических точных копий нет — освобождать нечего.</div>'
    : `<div class="sub">Удаление неканонических копий точных клонов освободит <b>${formatBytes(cleanup.totalBytes)}</b> (${formatNum(cleanup.totalFiles)} файлов). Панель ничего не удаляет сама.</div>
${cleanup.noCanonicalProjects.length ? `<div class="sub">Целиком неуникальные проекты: ${cleanup.noCanonicalProjects.slice(0, 8).map((r) => `<code>${esc(r.name)}</code>`).join(', ')}.</div>` : ''}
<table class="cleanup-table"><tr><th>Проект</th><th>Освободится</th><th>Файлов</th><th>Решение</th></tr>${cleanupRows}</table>`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Панель вайбкодинга · инвентаризация</title>
<style>
  :root { --bg:#f6f7f9; --card:#ffffff; --line:#e3e6ea; --text:#1b1f24; --muted:#6b7280; }
  * { box-sizing:border-box; }
  body { margin:0; padding:32px; background:var(--bg); color:var(--text);
         font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif; }
  h1 { font-size:22px; font-weight:600; margin:0 0 4px; }
  h2 { font-size:17px; font-weight:600; margin:36px 0 12px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:16px; }
  .summary { display:flex; gap:20px; flex-wrap:wrap; margin:16px 0 8px; }
  .kpi { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; min-width:120px; }
  .kpi b { display:block; font-size:20px; font-weight:600; }
  .kpi span { color:var(--muted); font-size:12px; }
  .stage-bar { display:flex; height:14px; border-radius:7px; overflow:hidden; background:#e9ecf0; margin:8px 0 6px; }
  .stage-seg { height:100%; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; color:var(--muted); font-size:12px; margin-bottom:8px; }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card header { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
  .card-title { font-weight:600; font-size:15px; word-break:break-word; }
  .stage-badge { font-size:11px; padding:2px 8px; border-radius:20px; white-space:nowrap; }
  .score-row { display:flex; align-items:center; gap:10px; margin:10px 0 8px; }
  .score-bar { flex:1; height:7px; background:#e9ecf0; border-radius:4px; overflow:hidden; }
  .score-fill { height:100%; border-radius:4px; }
  .score-num { font-variant-numeric:tabular-nums; font-weight:600; width:28px; text-align:right; }
  .metrics { display:flex; gap:12px; flex-wrap:wrap; color:var(--muted); font-size:12px; }
  .metrics b { color:var(--text); font-weight:600; }
  .stack { margin-top:8px; font-size:12px; color:var(--muted); }
  .chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
  .chip { font-size:11px; padding:2px 8px; border-radius:20px; background:#eef1f4; color:#4b5563; }
  .chip-stale { background:#fdeceb; color:#a32d2d; }
  .chip-dups { background:#fdf0e3; color:#854f0b; }
  .chip-nogit, .chip-noremote { background:#f1eefd; color:#534ab7; }
  .chip-orphan { background:#fdeceb; color:#a32d2d; }
  .chip-ok { background:#e7f4ec; color:#0f6e56; }
  .chip-exact { background:#e7f4ec; color:#0f6e56; }
  .chip-near { background:#fdf6e3; color:#8a6d1a; }
  .dup-sim { font-size:11px; color:#8a6d1a; }
  .dup-line { margin-top:8px; font-size:12px; color:#854f0b; }
  .penalties { margin:8px 0 0; padding-left:18px; color:var(--muted); font-size:12px; }
  .path { margin-top:10px; font-size:11px; color:#9aa1ab; word-break:break-all; }
  .dup-card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 16px; }
  .dup-head { margin-bottom:6px; }
  .dup-card ul { margin:0; padding-left:18px; }
  .dup-card li { font-size:12px; margin:2px 0; word-break:break-all; }
  .dup-proj { display:inline-block; min-width:110px; color:var(--muted); }
  .dup-more { font-size:12px; color:var(--muted); margin-top:4px; }
  .stage-S0 { background:#e24b4a; color:#fff; }
  .stage-S1 { background:#ef9f27; color:#fff; }
  .stage-S2 { background:#efc75e; color:#412402; }
  .stage-S3 { background:#85b7eb; color:#042c53; }
  .stage-S4 { background:#5dcaa5; color:#04342c; }
  .stage-S5 { background:#1d9e75; color:#fff; }
  footer { margin-top:40px; color:#9aa1ab; font-size:12px; }
</style>
</head>
<body>
<h1>Панель вайбкодинга · инвентаризация</h1>
<div class="sub">${esc(new Date(state.generatedAt).toLocaleString('ru-RU'))} · корни: ${roots.map((r) => esc(r)).join(', ')}</div>

<div class="summary">
  <div class="kpi"><b>${projects.length}</b><span>проектов</span></div>
  <div class="kpi"><b>${dupGroups.length}</b><span>групп клонов</span></div>
  <div class="kpi"><b>${crossExact}</b><span>межпроектных точных</span></div>
  <div class="kpi"><b>${formatBytes(exactWasted)}</b><span>можно освободить</span></div>
  <div class="kpi"><b>${formatNum(projects.reduce((a, p) => a + (p.loc || 0), 0))}</b><span>строк кода</span></div>
  <div class="kpi"><b>${scanSeconds(scan)} с</b><span>полный цикл</span></div>
</div>

<h2>Распределение по стадиям</h2>
<div class="stage-bar">${stageBar}</div>
<div class="legend">
  ${['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].map((s) => `<span><i class="stage-${s}"></i>${s} ${STAGE_LABEL[s]} — ${counts[s] || 0}</span>`).join('')}
</div>

<h2>Что требует решения <span class="sub" style="display:inline">· по приоритету</span></h2>
<div class="grid">${cards}</div>

<h2>Дубликаты <span class="sub" style="display:inline">· точные клоны и похожие файлы (minhash ≥ 85%)</span></h2>
${shown.length ? `<div class="grid">${dupCards}</div>` : '<div class="sub">Точных клонов не найдено.</div>'}

<h2>Кандидаты на удаление <span class="sub" style="display:inline">· неканонические точные копии</span></h2>
${cleanupSection}

<style>
  .cleanup-table { border-collapse: collapse; background: var(--card); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .cleanup-table th, .cleanup-table td { text-align: left; padding: 7px 14px; border-bottom: 1px solid var(--line); font-size: 13px; }
  .cleanup-table th { background: #eef1f4; color: #4b5563; font-weight: 600; }
  .chip-waste { background:#fdecec; color:#a33; }
</style>

<footer>Сгенерировано панелью вайбкодинга · инвентаризация + дубли</footer>
</body>
</html>`;
}

export async function writeReports(state, { dir = REPORTS_DIR } = {}) {
  await ensureVibeDir();
  // Каталог вывода может быть произвольным (--out) и не существовать.
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const mdPath = path.join(dir, `inventory-${stamp}.md`);
  const htmlPath = path.join(dir, `inventory-${stamp}.html`);
  await writeFile(mdPath, renderMarkdown(state), 'utf8');
  await writeFile(htmlPath, renderHtml(state), 'utf8');
  return { mdPath, htmlPath };
}
