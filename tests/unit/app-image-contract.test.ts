import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The runtime image is a hand-written allowlist: `pnpm build` output plus the
 * command scripts and every module those scripts import. A module added to
 * `scripts/backup.mjs` without a matching `COPY` is invisible until the backup
 * command fails in production, so the copy list is checked against the real
 * import graph.
 */

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');

/** Repo-relative paths the Dockerfile copies out of the build stage. */
function copiedPaths(): Set<string> {
  const lines = read('Dockerfile').split('\n');
  const copied = new Set<string>();
  for (const line of lines) {
    const match = /^COPY --from=build \S+ \/app\/(\S+) \.\/(\S+)$/u.exec(line);
    if (!match) continue;
    expect(match[1]).toBe(match[2]);
    copied.add(match[1]);
  }
  return copied;
}

/** Repo-relative local modules reachable from `entry` by relative imports. */
function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    for (const match of source.matchAll(/from '(\.[^']+)'/gu)) {
      const imported = resolve(dirname(resolve(process.cwd(), file)), match[1]);
      const relative = imported.slice(process.cwd().length + 1);
      if (relative.startsWith('src/')) pending.push(relative);
    }
  }
  return [...seen].sort();
}

describe('app image', () => {
  const copied = copiedPaths();

  it('copies the command scripts the image runs', () => {
    expect(copied).toContain('scripts/start.mjs');
    expect(copied).toContain('scripts/backup.mjs');
  });

  it('copies every module the commands import', () => {
    for (const entry of ['scripts/start.mjs', 'scripts/backup.mjs']) {
      const missing = moduleGraph(entry).filter((path) => !copied.has(path));
      expect(missing, `${entry} imports modules the image omits`).toEqual([]);
    }
  });

  it('keeps the receipt image archive on the backup path', () => {
    expect(moduleGraph('scripts/backup.mjs')).toContain(
      'src/lib/server/db/archive.js',
    );
  });
});
