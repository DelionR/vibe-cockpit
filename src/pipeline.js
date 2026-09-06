/**
 * Полный цикл сканирования — общий для CLI (`vibe scan`) и дашборда (POST /api/scan).
 * Прогресс отдаётся колбэком: { phase: 'roots'|'metrics'|'near'|'git', ... }.
 */
import { scan } from './scanner.js';
import { enrichWithGit } from './git.js';
import { appendEvent, buildState, saveSignatures, saveState } from './store.js';

export async function runScan(cfg, onProgress = () => {}) {
  const t0 = Date.now();
  const result = await scan(cfg, onProgress);
  onProgress({ phase: 'git' });
  const scanDone = Date.now();
  await enrichWithGit(result.projects);
  const gitMs = Date.now() - scanDone;

  const state = buildState(result, cfg);
  state.scan.gitMs = gitMs;
  state.scan.totalMs = Date.now() - t0;
  await saveState(state);
  await saveSignatures({ generatedAt: state.generatedAt, entries: result.nearSignatures || [] });

  const exactGroups = state.dupGroups.filter((g) => g.kind !== 'near').length;
  await appendEvent('scan.completed', {
    projects: state.projects.length,
    dupGroups: state.dupGroups.length,
    exactGroups,
    nearGroups: state.dupGroups.length - exactGroups,
    elapsedMs: state.scan.totalMs,
  });
  return state;
}
