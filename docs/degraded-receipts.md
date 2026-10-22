# When a receipt is hard to read

Receipt capture is deliberately capture-first: the photo and the raw OCR output
are kept even when the parse is wrong, so a bad scan costs a little review time
rather than data. This page covers how to take a photo that reads well, and what
to expect in review when it does not.

## Capture hints

- **Flatten the receipt.** Creases and curls hide characters and shift the
  price column. Smooth it on the counter, or press it under a book for a minute.
- **One receipt per shot.** Two overlapping receipts make two columns look like
  one, and the parser cannot tell which price belongs to which row.
- **Fill the frame, keep all edges.** The whole receipt — header and the final
  total — must be inside the photo. Cropping the footer removes the totals the
  review strip reconciles against.
- **Shoot from above, square to the receipt.** An angled shot narrows one end
  and misaligns the price column.
- **Light it evenly; no flash glare.** Overhead, diffused light reads best.
  Direct flash on thermal paper washes out whole lines.
- **Use the original, not a screenshot or a re-photographed screen.** Rescans
  lose the fine print that the OCR needs.
- **Long receipts: still one shot.** If the whole strip cannot fit legibly,
  prefer a sharper photo of the whole receipt over two overlapping halves; the
  app treats each upload as one receipt.
- **Let it focus.** Hold still until the camera has focused; motion blur is the
  most common way a clean receipt becomes an unreadable one.

The capture screen re-encodes the image on the device (≤ ~1.5 MB, ≤1600 px, EXIF
stripped), so there is no benefit to a larger original than that.

## What the scanner does with a hard receipt

- Every OCR line is accounted for. Lines that are not purchased items —
  subtotal, tax, total, header, footer, coupons — are kept as **parked rows**
  rather than dropped.
- Unreadable amounts and text stay verbatim, and the receipt records warnings
  (for example "no price column found" or "no subtotal or total found") instead
  of guessing.
- The totals strip shows the printed totals beside the item sum. A gap beyond
  max($0.05, 1%) is shown as a warning. It never blocks a commit.
- When the optional helper is configured, a receipt whose parse looks
  structurally weak is marked **low confidence** in review, with the reasons.
  This is a hint, not a gate: you can still bind lines, mark them unknown, or
  skip them. Without a helper the receipt reviews exactly as before.

## What to expect in review

1. **Check the header.** The store picker offers the best match from the
   receipt's own text; confirm or choose the store. A store is required before
   commit.
2. **Check each item row.** Correct the printed text and the prices when the OCR
   misread them. The parsed name is the scanner's reading; the printed text is
   what you can edit.
3. **Decide every item line** — bind it to an item, create one, mark it
   "can't identify" (unknown), or skip it. Unknown lines keep their price as
   unidentified spending and can be bound later. Commit is disabled while any
   item line is undecided.
4. **Treat the totals warning as a prompt, not an error.** Coupons, deposits and
   rounding can move the delta legitimately.
5. **Keep the receipt if it is mostly right.** A few corrected lines are normal;
   discarding loses the price data and the photo.

If a line is unreadable or the receipt is too faded to recover, the same capture
may still be worth keeping: the correct lines contribute price history, and the
unknown or parked rows stay as evidence.

## The optional helper

Where the household has configured `RECEIPT_HELPER_URL`, a low-confidence
receipt also offers **Re-parse with helper** in review. It sends the stored OCR
evidence to a second, server-side reader and replaces the parsed lines with its
output.

- The photo and the raw OCR text are **not** changed; only the derived lines,
  totals and warnings are rebuilt.
- It is a manual, two-tap action. Any line decisions made since the view was
  loaded are discarded by the replacement, so the app refuses a stale request
  and asks you to reload first.
- It can fail — the helper may be offline or return nothing usable. The receipt
  is left exactly as it was; correct the lines by hand instead.
- No engine ships by default and no quality claim is made: the tier is a seam
  for an evaluated engine later (see `docs/adr/0004-fallback-reparse-tier.md`).
  With it unconfigured, review works exactly as described above.

## If the photo is unusable

Discard it from review. The image is purged, the OCR text and lines are kept for
the audit trail, and the receipt stops appearing in the list and in price
history. Capture the receipt again — a discarded photo does not block re-upload
of the same bytes. Nothing about a receipt becomes canonical data without a
review and a commit.
