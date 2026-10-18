// @ts-check
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { UPLOAD_SPOOL_PREFIX } from '../receipts/upload-spool.js';

/**
 * Write a directory of receipt images into a tar archive, the file half of a
 * backup run (`scripts/backup.mjs`). Images are already compressed JPEG/PNG/
 * WebP, so the archive is stored uncompressed: gzip would burn CPU for almost
 * no size gain and would hide the archive from `tar -tf` debugging.
 *
 * The same invariants as the SQLite backup hold: the destination is never
 * overwritten, the result is created owner-only, the bytes on disk are verified
 * against what was written, and a failed archive is removed rather than left
 * looking like a usable backup.
 */

/** tar's fixed block size; headers and payloads are padded to it. */
const BLOCK_BYTES = 512;
const NAME_BYTES = 100;
const COPY_CHUNK_BYTES = 64 * 1024;

/**
 * @typedef {object} ArchiveManifest
 * @property {number} fileCount regular files written into the archive
 * @property {number} totalBytes total size of those files
 * @property {string} sha256 hash of the archive file as written to disk
 */

/**
 * @typedef {object} ArchiveEntry
 * @property {string} sourcePath absolute path on disk
 * @property {string} archiveName path inside the archive (directories end in `/`)
 * @property {'file' | 'directory'} type
 * @property {number} size
 * @property {number} mode
 * @property {number} mtimeMs
 */

/**
 * Archive a directory tree into a new tar file.
 *
 * A missing source directory is archived as an empty (but valid) archive, so a
 * deployment that never captured a receipt still produces the same artifact
 * pair that restore expects.
 *
 * @param {string} sourceDirectory
 * @param {string} destinationPath
 * @returns {ArchiveManifest}
 */
export function createDirectoryArchive(sourceDirectory, destinationPath) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationPath);
  if (existsSync(destination)) {
    throw new Error(
      'The backup destination already exists; it was not overwritten.',
    );
  }

  const entries = existsSync(source) ? collectEntries(source) : [];
  const files = entries.filter((entry) => entry.type === 'file');
  mkdirSync(dirname(destination), { recursive: true });

  const written = createHash('sha256');
  const descriptor = openSync(destination, 'wx', 0o600);
  try {
    /** @param {Buffer} chunk */
    const write = (chunk) => {
      written.update(chunk);
      writeSync(descriptor, chunk);
    };
    for (const entry of entries) writeEntry(entry, write);
    // Two zero blocks mark the end of a tar archive. Nothing follows them.
    write(Buffer.alloc(BLOCK_BYTES * 2));
  } catch (error) {
    closeSync(descriptor);
    rmSync(destination, { force: true });
    throw error;
  }
  closeSync(descriptor);
  chmodSync(destination, 0o600);

  const expected = written.digest('hex');
  if (hashFile(destination) !== expected) {
    rmSync(destination, { force: true });
    throw new Error(
      'The receipt image archive failed verification and was removed.',
    );
  }

  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.size, 0),
    sha256: expected,
  };
}

/**
 * Every file (and directory entry) under `directory`, in a stable order.
 * The upload route's in-flight spool files are skipped: they are a partially
 * written request body, not a captured receipt.
 *
 * @param {string} directory
 * @param {string} [prefix] archive-relative path of `directory`
 * @returns {ArchiveEntry[]}
 */
function collectEntries(directory, prefix = '') {
  /** @type {ArchiveEntry[]} */
  const entries = [];
  const children = readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const child of children) {
    if (child.name.startsWith(UPLOAD_SPOOL_PREFIX)) continue;
    const sourcePath = join(directory, child.name);
    const archiveName = prefix ? `${prefix}/${child.name}` : child.name;
    const stats = statSync(sourcePath);
    if (child.isDirectory()) {
      entries.push({
        sourcePath,
        archiveName: `${archiveName}/`,
        type: 'directory',
        size: 0,
        mode: stats.mode & 0o7777,
        mtimeMs: stats.mtimeMs,
      });
      entries.push(...collectEntries(sourcePath, archiveName));
    } else if (child.isFile()) {
      entries.push({
        sourcePath,
        archiveName,
        type: 'file',
        size: stats.size,
        mode: stats.mode & 0o7777,
        mtimeMs: stats.mtimeMs,
      });
    }
    // Symlinks and other special files are not receipt images: skipped rather
    // than followed into a file outside the storage directory.
  }
  return entries;
}

/**
 * @param {ArchiveEntry} entry
 * @param {(chunk: Buffer) => void} write
 */
function writeEntry(entry, write) {
  write(headerFor(entry));
  if (entry.type !== 'file') return;

  const descriptor = openSync(entry.sourcePath, 'r');
  try {
    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
    let remaining = entry.size;
    while (remaining > 0) {
      const read = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, remaining),
        null,
      );
      if (read <= 0) {
        throw new Error(
          `The receipt image ${entry.sourcePath} changed while it was archived.`,
        );
      }
      write(buffer.subarray(0, read));
      remaining -= read;
    }
  } finally {
    closeSync(descriptor);
  }

  const padding = (BLOCK_BYTES - (entry.size % BLOCK_BYTES)) % BLOCK_BYTES;
  if (padding > 0) write(Buffer.alloc(padding));
}

/**
 * A POSIX ustar header block for one entry.
 *
 * @param {ArchiveEntry} entry
 * @returns {Buffer}
 */
function headerFor(entry) {
  const block = Buffer.alloc(BLOCK_BYTES);
  if (Buffer.byteLength(entry.archiveName, 'utf8') > NAME_BYTES) {
    // The app's stored names are `<uuid>.<ext>`; a longer path means something
    // other than the upload route put a file in the storage directory, and a
    // truncated name would restore a corrupt archive. Fail loudly instead.
    throw new Error(
      `The archive path ${entry.archiveName} is too long for the tar format.`,
    );
  }
  block.write(entry.archiveName, 0, NAME_BYTES, 'utf8');
  writeOctal(block, 100, 8, entry.mode & 0o7777); // mode
  writeOctal(block, 108, 8, 0); // uid — restore is documented with --no-same-owner
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, entry.size);
  writeOctal(block, 136, 12, Math.floor(entry.mtimeMs / 1000));
  block.fill(0x20, 148, 156); // checksum field is spaces while it is computed
  block.write(entry.type === 'directory' ? '5' : '0', 156, 1, 'ascii');
  block.write('ustar', 257, 5, 'ascii');
  block.write('00', 263, 2, 'ascii');
  writeOctal(block, 148, 7, checksumOf(block));
  block[155] = 0x20; // 6 octal digits, NUL, space
  return block;
}

/**
 * @param {Buffer} block
 * @param {number} offset
 * @param {number} length
 * @param {number} value
 */
function writeOctal(block, offset, length, value) {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error(
      `The value ${value} does not fit in an octal header field of ${length} bytes.`,
    );
  }
  block.write(digits.padStart(length - 1, '0'), offset, length - 1, 'ascii');
}

/** @param {Buffer} block */
function checksumOf(block) {
  let total = 0;
  for (const byte of block) total += byte;
  return total;
}

/** @param {string} filePath */
function hashFile(filePath) {
  const hash = createHash('sha256');
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}
