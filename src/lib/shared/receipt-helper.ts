/**
 * The fallback re-parse tier's shared vocabulary. The deterministic parser is
 * version 1 (`RECEIPT_PARSE_VERSION`); lines produced by the optional helper
 * carry their own version so a stored parse records which reader produced it.
 *
 * `helperApplied` is not derived from the version: the parser's version will
 * eventually reach any fixed number, and an older deterministic parse must not
 * then read as helped output. The warning is the durable marker — it is written
 * with the helper's parse and survives in `receipts.ocr_warnings`.
 */
export const HELPER_PARSE_VERSION = 2;

/** Written into a helper re-parse's warnings; also how review knows it is helped. */
export const HELPER_REPARSE_WARNING = 're-parsed with the fallback helper';
