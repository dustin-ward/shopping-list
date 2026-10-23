import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDirectoryArchive } from '../../src/lib/server/db/archive.js';
import { UPLOAD_SPOOL_PREFIX } from '../../src/lib/server/receipts/upload-spool.js';

/**
 * The receipt-image archive is verified with the system `tar`, not with the
 * writer's own reader: an archive the writer agrees with is worth nothing if
 * real tar cannot list and extract it.
 */

const firstImage = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x11, 0x22, 0x33,
]);
const secondImage = Buffer.from('PNG-ish bytes that are not a real image');

let directory = '';
let sourceDir = '';
let backupDir = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'shopping-list-archive-'));
  sourceDir = join(directory, 'receipts');
  backupDir = join(directory, 'backups');
  mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** List an archive's member names, in archive order, with the system tar. */
function tarListing(archivePath: string): string[] {
  return execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Extract an archive with the system tar and return the extracted directory. */
function untar(archivePath: string): string {
  const destination = join(directory, `restored-${Math.random()}`);
  mkdirSync(destination, { recursive: true });
  // `--no-same-owner` mirrors the documented restore procedure.
  execFileSync('tar', [
    '-xf',
    archivePath,
    '-C',
    destination,
    '--no-same-owner',
  ]);
  return destination;
}

describe('directory archive', () => {
  it('round-trips receipt images through real tar', () => {
    writeFileSync(join(sourceDir, 'a-first.jpg'), firstImage);
    writeFileSync(join(sourceDir, 'b-second.png'), secondImage);

    const archivePath = join(backupDir, 'receipts.tar');
    const manifest = createDirectoryArchive(sourceDir, archivePath);

    expect(manifest).toEqual({
      fileCount: 2,
      totalBytes: firstImage.length + secondImage.length,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(statSync(archivePath).mode & 0o777).toBe(0o600);
    expect(tarListing(archivePath)).toEqual(['a-first.jpg', 'b-second.png']);

    const restored = untar(archivePath);
    expect(readFileSync(join(restored, 'a-first.jpg'))).toEqual(firstImage);
    expect(readFileSync(join(restored, 'b-second.png'))).toEqual(secondImage);
  });

  it('keeps nested directories and skips in-flight upload temp files', () => {
    mkdirSync(join(sourceDir, 'nested'));
    writeFileSync(join(sourceDir, 'nested', 'deep.jpg'), firstImage);
    writeFileSync(join(sourceDir, `${UPLOAD_SPOOL_PREFIX}9f1c`), secondImage);

    const archivePath = join(backupDir, 'nested.tar');
    const manifest = createDirectoryArchive(sourceDir, archivePath);

    expect(manifest.fileCount).toBe(1);
    expect(tarListing(archivePath)).toEqual(['nested/', 'nested/deep.jpg']);
    expect(
      readFileSync(join(untar(archivePath), 'nested', 'deep.jpg')),
    ).toEqual(firstImage);
  });

  it('produces a valid empty archive when no images have been captured', () => {
    const archivePath = join(backupDir, 'empty.tar');
    const manifest = createDirectoryArchive(
      join(directory, 'missing'),
      archivePath,
    );

    expect(manifest.fileCount).toBe(0);
    expect(manifest.totalBytes).toBe(0);
    expect(tarListing(archivePath)).toEqual([]);
    expect(untar(archivePath)).toBeTruthy();
  });

  it('refuses to overwrite an existing archive', () => {
    mkdirSync(backupDir, { recursive: true });
    const archivePath = join(backupDir, 'existing.tar');
    writeFileSync(archivePath, 'not an archive');

    expect(() => createDirectoryArchive(sourceDir, archivePath)).toThrow(
      /already exists/u,
    );
    expect(readFileSync(archivePath, 'utf8')).toBe('not an archive');
  });

  it('fails loudly on a path it cannot name and leaves no partial archive', () => {
    writeFileSync(join(sourceDir, `${'x'.repeat(120)}.jpg`), firstImage);

    const archivePath = join(backupDir, 'too-long.tar');
    expect(() => createDirectoryArchive(sourceDir, archivePath)).toThrow(
      /too long for the tar format/u,
    );
    expect(existsSync(archivePath)).toBe(false);
  });
});
