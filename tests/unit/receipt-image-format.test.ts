import { describe, expect, it } from 'vitest';
import { detectImageFormat } from '../../src/lib/server/receipts/image-format';

describe('detectImageFormat', () => {
  it('classifies JPEG, PNG, and WebP magic bytes', () => {
    expect(
      detectImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
    ).toBe('jpg');
    expect(
      detectImageFormat(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      ),
    ).toBe('png');
    expect(
      detectImageFormat(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from('WEBP', 'latin1'),
        ]),
      ),
    ).toBe('webp');
  });

  it('rejects payloads whose leading bytes do not match a supported format', () => {
    expect(
      detectImageFormat(Buffer.from('GIF89a not an image', 'latin1')),
    ).toBeNull();
    expect(
      detectImageFormat(
        Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.from([0x00, 0x00, 0x00, 0x00]),
          Buffer.from('WAVE', 'latin1'),
        ]),
      ),
    ).toBeNull();
    expect(detectImageFormat(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageFormat(Buffer.alloc(0))).toBeNull();
  });
});
