import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, badRequest } from '../errors';
import { UPLOAD_SPOOL_PREFIX } from './upload-spool.js';

/**
 * Route-local multipart reader for the receipt upload route. The shared
 * `parseJson` body parser rejects non-JSON payloads outright, and adapter-node
 * only caps the raw body, so the upload route streams the single image part out
 * of the multipart body itself: framing bytes are held back in memory, the
 * image is written straight to the receipt storage directory, and the size cap
 * is enforced while streaming rather than after buffering.
 */

/** Framing overhead (boundaries, part headers) tolerated above the image cap. */
const FRAMING_SLACK_BYTES = 64 * 1024;
/** Leading bytes retained to classify the image by its magic bytes. */
const MAGIC_BYTES = 16;

const CRLF = Buffer.from('\r\n');
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');
const CLOSING_BOUNDARY = Buffer.from('--');

const rawBodyLimit = (maxBytes: number): number =>
  maxBytes + FRAMING_SLACK_BYTES;

export type MultipartFilePart = {
  /** Spooled image file inside the receipt storage directory. */
  tempPath: string;
  bytes: number;
  sha256: string;
  /** Leading image bytes, enough to classify the format. */
  magicBytes: Buffer;
};

export type MultipartReaderOptions = {
  tempDir: string;
  maxBytes: number;
};

export async function readMultipartFilePart(
  request: Request,
  options: MultipartReaderOptions,
): Promise<MultipartFilePart> {
  const boundary = parseBoundary(request.headers.get('content-type'));
  if (!boundary) {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Send the image as multipart/form-data.',
    );
  }

  const source = request.body;
  if (!source) {
    throw badRequest('MISSING_IMAGE', 'Attach an image to upload.');
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > rawBodyLimit(options.maxBytes)
  ) {
    throw requestTooLarge();
  }

  mkdirSync(options.tempDir, { recursive: true });
  const tempPath = join(
    options.tempDir,
    `${UPLOAD_SPOOL_PREFIX}${randomUUID()}`,
  );
  const descriptor = openSync(tempPath, 'wx');
  const stream = new ByteStream(source.getReader(), options.maxBytes);
  const hash = createHash('sha256');
  const magicChunks: Buffer[] = [];
  let magicLength = 0;
  let fileBytes = 0;

  const sink = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    fileBytes += chunk.length;
    if (fileBytes > options.maxBytes) throw imageTooLarge(options.maxBytes);
    if (magicLength < MAGIC_BYTES) {
      const slice = chunk.subarray(0, MAGIC_BYTES - magicLength);
      magicChunks.push(Buffer.from(slice));
      magicLength += slice.length;
    }
    hash.update(chunk);
    writeSync(descriptor, chunk);
  };

  try {
    const found = await readFilePart(stream, boundary, sink);
    if (!found) throw badRequest('MISSING_IMAGE', 'Attach an image to upload.');
    return {
      tempPath,
      bytes: fileBytes,
      sha256: hash.digest('hex'),
      magicBytes: Buffer.concat(magicChunks),
    };
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  } finally {
    closeSync(descriptor);
    await stream.drain();
  }
}

/** Stream the first part that has a filename into `sink`; skip other parts. */
async function readFilePart(
  stream: ByteStream,
  boundary: string,
  sink: (chunk: Buffer) => void,
): Promise<boolean> {
  await stream.until(Buffer.from(`--${boundary}`));
  const afterFirstBoundary = await stream.take(CLOSING_BOUNDARY.length);
  if (afterFirstBoundary.equals(CLOSING_BOUNDARY)) return false;
  if (!afterFirstBoundary.equals(CRLF)) throw invalidMultipart();

  const terminator = Buffer.from(`\r\n--${boundary}`);
  for (;;) {
    const headerChunks: Buffer[] = [];
    await stream.until(HEADER_TERMINATOR, (chunk) => headerChunks.push(chunk));
    const headers = parseHeaders(Buffer.concat(headerChunks));
    const filename = (headers.filename ?? '').trim();

    if (filename.length > 0) {
      await stream.until(terminator, sink);
      return true;
    }

    // Not the image: discard the part body and move on to the next one.
    await stream.until(terminator);
    const afterPart = await stream.take(CLOSING_BOUNDARY.length);
    if (afterPart.equals(CLOSING_BOUNDARY)) return false;
    if (!afterPart.equals(CRLF)) throw invalidMultipart();
  }
}

function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const [type, ...parameters] = contentType.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') return null;
  for (const parameter of parameters) {
    const separator = parameter.indexOf('=');
    if (separator < 0) continue;
    if (parameter.slice(0, separator).trim().toLowerCase() !== 'boundary') {
      continue;
    }
    const raw = parameter.slice(separator + 1).trim();
    const value =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    return value.length > 0 ? value : null;
  }
  return null;
}

type PartHeaders = {
  filename: string | null;
};

function parseHeaders(raw: Buffer): PartHeaders {
  const headers: PartHeaders = { filename: null };
  for (const line of raw.toString('utf8').split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    if (key !== 'content-disposition') continue;
    const value = line.slice(separator + 1).trim();
    headers.filename = matchParameter(value, 'filename');
  }
  return headers;
}

function matchParameter(value: string, parameter: string): string | null {
  const quoted = new RegExp(`${parameter}="([^"]*)"`, 'i').exec(value);
  if (quoted) return quoted[1];
  const bare = new RegExp(`${parameter}=([^;\\s]+)`, 'i').exec(value);
  return bare ? bare[1] : null;
}

function imageTooLarge(maxBytes: number): AppError {
  const megabytes = Math.round(maxBytes / (1024 * 1024));
  return new AppError(
    413,
    'IMAGE_TOO_LARGE',
    `Receipt images must be ${megabytes} MB or smaller.`,
  );
}

function requestTooLarge(): AppError {
  return new AppError(
    413,
    'REQUEST_TOO_LARGE',
    'The upload request is too large.',
  );
}

function invalidMultipart(): AppError {
  return badRequest(
    'INVALID_MULTIPART',
    'The upload body could not be read as multipart/form-data.',
  );
}

/**
 * Buffered view over a request body stream that searches for delimiters while
 * retaining only the bytes that could still belong to a split delimiter.
 */
class ByteStream {
  private buffer = Buffer.alloc(0);
  private cursor = 0;
  private received = 0;
  private ended = false;

  constructor(
    private readonly source: ReadableStreamDefaultReader<Uint8Array>,
    private readonly maxBytes: number,
  ) {}

  private get pending(): Buffer {
    return this.buffer.subarray(this.cursor);
  }

  async take(length: number): Promise<Buffer> {
    while (this.pending.length < length) {
      if (!(await this.refill())) throw invalidMultipart();
    }
    const value = Buffer.from(this.pending.subarray(0, length));
    this.consume(length);
    return value;
  }

  async until(marker: Buffer, sink?: (chunk: Buffer) => void): Promise<void> {
    for (;;) {
      const pending = this.pending;
      const index = pending.indexOf(marker);
      if (index >= 0) {
        if (sink && index > 0) sink(Buffer.from(pending.subarray(0, index)));
        this.consume(index + marker.length);
        return;
      }

      const holdback = marker.length - 1;
      if (pending.length > holdback) {
        const emit = Buffer.from(
          pending.subarray(0, pending.length - holdback),
        );
        if (sink) sink(emit);
        this.consume(emit.length);
      }

      if (!(await this.refill())) throw invalidMultipart();
    }
  }

  /**
   * Consume whatever remains of the body. Cancelling the request stream instead
   * tears down the connection before the response is written, so the tail is
   * read and discarded (best effort) even though the image part is complete.
   */
  async drain(): Promise<void> {
    try {
      while (await this.refill()) {
        this.consume(this.pending.length);
      }
    } catch {
      // Never let draining the tail mask the real outcome.
    }
  }

  private consume(length: number): void {
    this.cursor += length;
    if (this.cursor >= this.buffer.length) {
      this.buffer = Buffer.alloc(0);
      this.cursor = 0;
    }
  }

  private async refill(): Promise<boolean> {
    if (this.ended) return false;
    const { value, done } = await this.source.read();
    if (done) {
      this.ended = true;
      return false;
    }

    const chunk = Buffer.from(value);
    this.received += chunk.length;
    if (this.received > rawBodyLimit(this.maxBytes)) {
      throw requestTooLarge();
    }

    const pending = this.buffer.subarray(this.cursor);
    this.buffer = Buffer.concat([pending, chunk]);
    this.cursor = 0;
    return true;
  }
}
