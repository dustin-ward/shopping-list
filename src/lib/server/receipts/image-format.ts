export type ReceiptImageFormat = 'jpg' | 'png' | 'webp';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_MAGIC = Buffer.from('RIFF', 'latin1');
const WEBP_MAGIC = Buffer.from('WEBP', 'latin1');

/**
 * Classify uploaded bytes by their leading magic bytes. Only the three formats
 * the capture client produces reach storage; anything else is rejected before a
 * receipt row or file is created.
 */
export function detectImageFormat(head: Uint8Array): ReceiptImageFormat | null {
  const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head);
  if (bytes.subarray(0, 3).equals(JPEG_MAGIC)) return 'jpg';
  if (bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).equals(RIFF_MAGIC) &&
    bytes.subarray(8, 12).equals(WEBP_MAGIC)
  ) {
    return 'webp';
  }
  return null;
}
