import { describe, expect, it, vi } from 'vitest';
import {
  ReceiptImageError,
  encodeUnderLimit,
  fitWithin,
  prepareReceiptImage,
  type ReceiptImageDeps,
} from '../../src/lib/client/receipt-image';

function blob(size: number, type = 'image/webp'): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

describe('fitWithin', () => {
  it('keeps an image under the max edge at its original size', () => {
    expect(fitWithin(800, 1200)).toEqual({ width: 800, height: 1200 });
    expect(fitWithin(1600, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('scales the longest edge down to the max, preserving the ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(3200, 800)).toEqual({ width: 1600, height: 400 });
  });

  it('never rounds an edge down to zero', () => {
    expect(fitWithin(8000, 3)).toEqual({ width: 1600, height: 1 });
  });

  it('rejects dimensions that are not positive finite numbers', () => {
    expect(() => fitWithin(0, 100)).toThrow(ReceiptImageError);
    expect(() => fitWithin(100, Number.NaN)).toThrow(ReceiptImageError);
  });
});

describe('encodeUnderLimit', () => {
  it('prefers the first type that lands under the target at the best quality', async () => {
    const attempts: string[] = [];
    const encode = vi.fn(async (type: string, quality: number) => {
      attempts.push(`${type}@${quality}`);
      return blob(100);
    });

    const result = await encodeUnderLimit(encode, { maxBytes: 1000 });

    expect(result.size).toBe(100);
    expect(attempts).toEqual(['image/webp@0.82']);
  });

  it('walks the quality ladder until the encoded image fits', async () => {
    const encode = vi.fn(async (_type: string, quality: number) =>
      quality > 0.7 ? blob(5000) : blob(900),
    );

    const result = await encodeUnderLimit(encode, { maxBytes: 1000 });

    expect(result.size).toBe(900);
    expect(encode).toHaveBeenCalledTimes(2);
  });

  it('falls through to the next type when the preferred one cannot encode', async () => {
    const encode = vi.fn(async (type: string) =>
      type === 'image/webp' ? null : blob(500, 'image/jpeg'),
    );

    const result = await encodeUnderLimit(encode, { maxBytes: 1000 });

    expect(result.type).toBe('image/jpeg');
  });

  it('accepts an over-target image that still fits the upload ceiling', async () => {
    const encode = vi.fn(async () => blob(4000));

    const result = await encodeUnderLimit(encode, {
      maxBytes: 1000,
      hardMaxBytes: 5000,
    });

    expect(result.size).toBe(4000);
  });

  it('rejects an image whose smallest encoding is over the upload ceiling', async () => {
    const encode = vi.fn(async () => blob(6000));

    await expect(
      encodeUnderLimit(encode, { maxBytes: 1000, hardMaxBytes: 5000 }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  it('rejects when no type produces an image at all', async () => {
    const encode = vi.fn(async () => null);

    await expect(encodeUnderLimit(encode)).rejects.toMatchObject({
      code: 'encode-failed',
    });
  });
});

describe('prepareReceiptImage', () => {
  function deps(overrides: Partial<ReceiptImageDeps> = {}): ReceiptImageDeps {
    return {
      decode: async () => ({
        source: {} as CanvasImageSource,
        width: 4000,
        height: 3000,
        release: vi.fn(),
      }),
      encode: async () => blob(100),
      ...overrides,
    };
  }

  it('encodes the fitted size and returns the re-encoded image', async () => {
    const encode = vi.fn(async () => blob(100, 'image/webp'));
    const file = new File(['raw-camera-original'], 'photo.jpg', {
      type: 'image/jpeg',
    });

    const prepared = await prepareReceiptImage(file, deps({ encode }));

    expect(encode).toHaveBeenCalledWith(
      expect.anything(),
      { width: 1600, height: 1200 },
      'image/webp',
      0.82,
    );
    expect(prepared).toMatchObject({ width: 1600, height: 1200 });
    expect(prepared.blob).toBeInstanceOf(Blob);
  });

  it('never returns the raw camera original', async () => {
    const file = new File(['raw-camera-original'], 'photo.jpg', {
      type: 'image/jpeg',
    });

    const prepared = await prepareReceiptImage(
      file,
      deps({
        encode: async () => new Blob(['re-encoded'], { type: 'image/webp' }),
      }),
    );

    expect(await prepared.blob.text()).toBe('re-encoded');
  });

  it('rejects a file that is not a photo before decoding it', async () => {
    const decode = vi.fn();
    const file = new File(['pdf'], 'receipt.pdf', {
      type: 'application/pdf',
    });

    await expect(
      prepareReceiptImage(file, deps({ decode })),
    ).rejects.toMatchObject({ code: 'unsupported-type' });
    expect(decode).not.toHaveBeenCalled();
  });

  it('reports an unreadable image as a decode failure', async () => {
    const file = new File(['broken'], 'photo.jpg', { type: 'image/jpeg' });

    await expect(
      prepareReceiptImage(
        file,
        deps({
          decode: async () => {
            throw new Error('bad bytes');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'decode-failed' });
  });

  it('releases the decoded image even when encoding fails', async () => {
    const release = vi.fn();
    const file = new File(['photo'], 'photo.jpg', { type: 'image/jpeg' });

    await expect(
      prepareReceiptImage(
        file,
        deps({
          decode: async () => ({
            source: {} as CanvasImageSource,
            width: 100,
            height: 100,
            release,
          }),
          encode: async () => null,
        }),
      ),
    ).rejects.toMatchObject({ code: 'encode-failed' });
    expect(release).toHaveBeenCalledOnce();
  });
});
