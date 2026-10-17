/**
 * Origins of the two servers the e2e suite starts (see playwright.config.ts):
 * the default one with the receipt feature off, and one with RECEIPT_OCR_URL
 * set so the Receipts tab exists.
 */
export const featureOffPort = 4173;
export const featureOnPort = 4174;
export const featureOffOrigin = `http://127.0.0.1:${featureOffPort}`;
export const featureOnOrigin = `http://127.0.0.1:${featureOnPort}`;
