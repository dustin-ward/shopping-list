/**
 * Client-side capture preparation: turn a camera photo into a small, upright,
 * metadata-free image before it ever leaves the device.
 *
 * The browser pass is a re-encode, so EXIF (GPS included) is dropped by
 * construction, and the bitmap is decoded with `imageOrientation: 'from-image'`
 * so the encoded pixels are already rotated the way the photo was taken. The
 * pure geometry and encoding-ladder decisions are injectable so they can be
 * tested without a canvas.
 */

/** Longest edge kept after re-encode (the plan's ≤1600 px). */
export const MAX_IMAGE_EDGE_PX = 1600;

/** Client target for one capture — the plan's "≤ ~1.5 MB". */
export const TARGET_IMAGE_BYTES = 1_572_864;

/** Ceiling the server enforces (10 MB); stay just under it. */
export const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;

const ENCODE_TYPES = ['image/webp', 'image/jpeg'] as const;
const ENCODE_QUALITIES = [0.82, 0.7, 0.55, 0.4] as const;

/** Types the upload endpoint accepts, so capture fails fast on anything else. */
const SUPPORTED_INPUT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export type ReceiptImageErrorCode =
  'unsupported-type' | 'decode-failed' | 'encode-failed' | 'too-large';

const UNREADABLE_MESSAGE =
  "That image couldn't be read. Try taking the photo again.";
const UNENCODABLE_MESSAGE =
  "This device couldn't prepare the photo for upload.";

/** Shared with the upload layer, which maps a server 413 to the same sentence. */
export const TOO_LARGE_MESSAGE =
  'That photo is too large to upload. Try taking a closer photo of the receipt.';

export class ReceiptImageError extends Error {
  readonly code: ReceiptImageErrorCode;

  constructor(code: ReceiptImageErrorCode, message: string) {
    super(message);
    this.name = 'ReceiptImageError';
    this.code = code;
  }
}

export type FitSize = { width: number; height: number };

/**
 * Scale a photo down so its longest edge is at most `maxEdge`. Images that
 * already fit are returned untouched; the ratio is preserved and no edge is
 * ever rounded away to zero.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_IMAGE_EDGE_PX,
): FitSize {
  if (!isPositiveSize(width) || !isPositiveSize(height)) {
    throw new ReceiptImageError('decode-failed', UNREADABLE_MESSAGE);
  }
  if (width <= maxEdge && height <= maxEdge) return { width, height };

  const scale = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function isPositiveSize(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export type EncodeAttempt = (
  type: string,
  quality: number,
) => Promise<Blob | null>;

export type EncodeOptions = {
  /** Preferred ceiling; the ladder stops at the first image that fits. */
  maxBytes?: number;
  /** Last resort ceiling — over this the capture is rejected as too large. */
  hardMaxBytes?: number;
  types?: readonly string[];
  qualities?: readonly number[];
};

/**
 * Encode with the best quality that lands under `maxBytes`, preferring the
 * earlier types (WebP, then JPEG). A type that cannot encode (or silently
 * produces a different format) is skipped. If nothing fits the target but the
 * smallest attempt still fits the server ceiling, that image is returned rather
 * than losing the capture; anything over the ceiling is rejected as too large.
 */
export async function encodeUnderLimit(
  encode: EncodeAttempt,
  options: EncodeOptions = {},
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? TARGET_IMAGE_BYTES;
  const hardMaxBytes = options.hardMaxBytes ?? MAX_UPLOAD_BYTES;
  const types = options.types ?? ENCODE_TYPES;
  const qualities = options.qualities ?? ENCODE_QUALITIES;

  let smallest: Blob | null = null;
  for (const type of types) {
    for (const quality of qualities) {
      const blob = await encode(type, quality);
      if (!blob || !blob.type.startsWith('image/')) continue;
      if (blob.size <= maxBytes) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }
  }

  if (!smallest) {
    throw new ReceiptImageError('encode-failed', UNENCODABLE_MESSAGE);
  }
  if (smallest.size > hardMaxBytes) {
    throw new ReceiptImageError('too-large', TOO_LARGE_MESSAGE);
  }
  return smallest;
}

export type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release?: () => void;
};

export type ReceiptImageDeps = {
  /** Decode a file into an oriented bitmap. */
  decode: (file: Blob) => Promise<DecodedImage>;
  /** Draw and re-encode at the given size. Returns null when unsupported. */
  encode: (
    source: CanvasImageSource,
    size: FitSize,
    type: string,
    quality: number,
  ) => Promise<Blob | null>;
};

export type PreparedReceiptImage = {
  /** The only bytes that are ever uploaded. */
  blob: Blob;
  width: number;
  height: number;
};

/**
 * Validate, decode, downscale, and re-encode one capture. The returned blob is
 * always freshly encoded — the original file bytes are never passed through.
 */
export async function prepareReceiptImage(
  file: File,
  deps: ReceiptImageDeps = browserImageDeps(),
): Promise<PreparedReceiptImage> {
  assertSupportedFile(file);

  let decoded: DecodedImage;
  try {
    decoded = await deps.decode(file);
  } catch (error) {
    if (error instanceof ReceiptImageError) throw error;
    throw new ReceiptImageError('decode-failed', UNREADABLE_MESSAGE);
  }

  try {
    const size = fitWithin(decoded.width, decoded.height);
    const blob = await encodeUnderLimit((type, quality) =>
      deps.encode(decoded.source, size, type, quality),
    );
    return { blob, width: size.width, height: size.height };
  } finally {
    decoded.release?.();
  }
}

/** Fail fast on files the upload endpoint would reject anyway. */
function assertSupportedFile(file: File): void {
  if (file.type && !SUPPORTED_INPUT_TYPES.has(file.type)) {
    throw new ReceiptImageError(
      'unsupported-type',
      "That file isn't a photo. Capture a JPEG, PNG, or WebP image.",
    );
  }
}

function browserImageDeps(): ReceiptImageDeps {
  return { decode: decodeImage, encode: encodeWithCanvas };
}

async function decodeImage(file: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' bakes in the EXIF orientation, so the re-encode is upright.
      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the <img> path: browsers apply EXIF orientation to
      // images by default, and it also copes with engines that lack the option.
    }
  }

  const image = await loadImageElement(file);
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

function loadImageElement(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode the image.'));
    };
    image.src = url;
  });
}

async function encodeWithCanvas(
  source: CanvasImageSource,
  size: FitSize,
  type: string,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new ReceiptImageError('encode-failed', UNENCODABLE_MESSAGE);
  }
  context.drawImage(source, 0, 0, size.width, size.height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (blob) => {
        // Browsers fall back to PNG for unsupported types; treat that as a
        // failed attempt so the ladder can try the next type.
        resolve(blob && blob.type === type ? blob : null);
      },
      type,
      quality,
    );
  });
}
