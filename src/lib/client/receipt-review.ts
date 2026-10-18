/**
 * The review editor's client half: what a row's form means, and how an edit
 * reaches the server.
 *
 * A row submits whatever the reviewer touched. Reading that form is pure — it
 * turns typed text into the patch the API takes, or into a message the reviewer
 * can act on — while saving is one `PATCH` against the receipt, carrying the
 * `updatedAt` the editor last saw so a stale edit is refused rather than
 * silently overwriting someone else's.
 */

import { requestJson } from './api';
import { parseMoneyInput } from './money';
import {
  receiptQuantityUnitSchema,
  type ReceiptDetail,
  type ReceiptDetailLine,
  type ReceiptLinePatch,
  type UpdateReceiptInput,
} from '../shared/schemas';

/** One row's form exactly as it was typed. */
export type LineEditFields = {
  rawText: string;
  quantityReal: string;
  quantityText: string;
  quantityUnit: string;
  unitPriceMinor: string;
  totalPriceMinor: string;
};

/** One row's form after it has been read: what the API would be sent. */
type ReadFields = Pick<
  ReceiptLinePatch,
  | 'rawText'
  | 'quantityReal'
  | 'quantityText'
  | 'quantityUnit'
  | 'unitPriceMinor'
  | 'totalPriceMinor'
>;

export type LineEditResult =
  { ok: true; patch: ReceiptLinePatch | null } | { ok: false; message: string };

/**
 * Read one row's form against the line it was filled from. Only the fields that
 * actually changed are sent, and a form that matches the stored line is not an
 * edit at all — which is what keeps a blur and the Enter key from saving twice.
 */
export function lineEditPatch(
  fields: LineEditFields,
  line: ReceiptDetailLine,
): LineEditResult {
  const rawText = fields.rawText.trim();
  if (!rawText) return { ok: false, message: 'Printed text cannot be empty.' };

  const quantityReal = readQuantity(fields.quantityReal);
  if (!quantityReal.ok) {
    return { ok: false, message: 'Quantity must be a positive number.' };
  }

  const quantityText = fields.quantityText.trim() || null;
  if (quantityText !== null && quantityText.length > 80) {
    return {
      ok: false,
      message: 'Printed quantity can be up to 80 characters.',
    };
  }

  const quantityUnit = readUnit(fields.quantityUnit);
  if (!quantityUnit.ok) {
    return { ok: false, message: 'Choose a unit from the list.' };
  }

  const unitPriceMinor = readPrice(fields.unitPriceMinor);
  const totalPriceMinor = readPrice(fields.totalPriceMinor);
  if (!unitPriceMinor.ok || !totalPriceMinor.ok) {
    return { ok: false, message: 'Prices look like 3.49 (or -1.50).' };
  }

  const patch = withoutUnchanged(
    {
      rawText,
      quantityReal: quantityReal.value,
      quantityText,
      quantityUnit: quantityUnit.value,
      unitPriceMinor: unitPriceMinor.value,
      totalPriceMinor: totalPriceMinor.value,
    },
    line,
  );
  return {
    ok: true,
    patch: Object.keys(patch).length ? patch : null,
  };
}

/** Save one receipt's review edits; the server answers with the fresh detail. */
export function saveReceiptReview(
  receiptId: string,
  input: UpdateReceiptInput,
): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}`, {
    method: 'PATCH',
    body: input,
  });
}

/** Read the receipt again, after an edit was refused as stale. */
export function fetchReceiptDetail(receiptId: string): Promise<ReceiptDetail> {
  return requestJson<ReceiptDetail>(`/api/receipts/${receiptId}`);
}

/** A field the reviewer typed: either its value (or `null` for "cleared"), or a typo. */
type Read<T> = { ok: true; value: T | null } | { ok: false };

function readQuantity(value: string): Read<number> {
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return { ok: false };
  const quantity = Number(text);
  return quantity > 0 ? { ok: true, value: quantity } : { ok: false };
}

function readUnit(value: string): Read<ReceiptDetailLine['quantityUnit']> {
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  const parsed = receiptQuantityUnitSchema.safeParse(text);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

function readPrice(value: string): Read<number> {
  if (!value.trim()) return { ok: true, value: null };
  const minor = parseMoneyInput(value);
  return minor === null ? { ok: false } : { ok: true, value: minor };
}

/** The typed fields that differ from the line's stored values. */
function withoutUnchanged(
  fields: Required<ReadFields>,
  line: ReceiptDetailLine,
): ReceiptLinePatch {
  const patch: ReceiptLinePatch = {};
  if (fields.rawText !== line.rawText) patch.rawText = fields.rawText;
  if (fields.quantityReal !== line.quantityReal)
    patch.quantityReal = fields.quantityReal;
  if (fields.quantityText !== line.quantityText)
    patch.quantityText = fields.quantityText;
  if (fields.quantityUnit !== line.quantityUnit)
    patch.quantityUnit = fields.quantityUnit;
  if (fields.unitPriceMinor !== line.unitPriceMinor)
    patch.unitPriceMinor = fields.unitPriceMinor;
  if (fields.totalPriceMinor !== line.totalPriceMinor)
    patch.totalPriceMinor = fields.totalPriceMinor;
  return patch;
}
