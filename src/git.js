import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Принудительный UTF-8 и отключение экранирования путей — иначе кириллица в путях превращается в \320\244
const GIT_FLAGS = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=utf-8'];

async function git(cwd, args, timeout = 8000) {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_FLAGS, ...args], {
      cwd,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Ограничение параллелизма, чтобы не порождать сотни процессов git. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Собирает git-состояние проекта.
 * Возвращает null, если каталог не является репозиторием.
 */
async function collectOne(dir, hasDotGit) {
  if (!hasDotGit) return null;

  const isRepo = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (isRepo !== 'true') return null;

  const [branch, remote, lastCommitTs, dirtyRaw, worktreesRaw] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['remote', 'get-url', 'origin'], 5000),
    git(dir, ['log', '-1', '--format=%ct']),
    git(dir, ['status', '--porcelain']),
    git(dir, ['worktree', 'list']),
  ]);

  const dirty = dirtyRaw ? dirtyRaw.split('\n').filter(Boolean).length : 0;
  const worktrees = worktreesRaw ? worktreesRaw.split('\n').filter(Boolean).length : 1;

  return {
    branch: branch || null,
    remote: remote || null,
    lastCommitAt: lastCommitTs ? new Date(Number(lastCommitTs) * 1000).toISOString() : null,
    uncommitted: dirty,
    worktrees,
  };
}

export async function enrichWithGit(projects, concurrency = 6) {
  return pool(projects, concurrency, async (p) => {
    const g = await collectOne(p.path, p.has?.git);
    p.git = g;
    return p;
  });
}
