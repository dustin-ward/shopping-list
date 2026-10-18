// @ts-check

/**
 * File-name prefix the upload route gives a receipt image that is still being
 * streamed to disk in the receipt storage directory (see `multipart.ts`).
 *
 * It lives in a plain-JavaScript module because two very different consumers
 * must agree on it: the route (TypeScript, bundled into `build/`) and
 * `scripts/backup.mjs` (plain Node, shipped as source and imported per file
 * into the runtime image). An archive that stopped skipping in-flight uploads
 * would capture a truncated image, so the name is defined once.
 */
export const UPLOAD_SPOOL_PREFIX = '.incoming-';
