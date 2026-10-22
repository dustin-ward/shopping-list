/**
 * Origins of the three servers the e2e suite starts (see playwright.config.ts):
 * the default one with the receipt feature off, one with RECEIPT_OCR_URL set so
 * the Receipts tab exists, and one whose stub OCR replays a low-confidence
 * fixture with a fallback helper configured.
 */
export const featureOffPort = 4173;
export const featureOnPort = 4174;
export const helperPort = 4175;
export const featureOffOrigin = `http://127.0.0.1:${featureOffPort}`;
export const featureOnOrigin = `http://127.0.0.1:${featureOnPort}`;
export const helperOrigin = `http://127.0.0.1:${helperPort}`;
