<script lang="ts">
  import { ApiError } from '../../client/api';
  import {
    fetchReceiptDetail,
    saveReceiptReview,
  } from '../../client/receipt-review';
  import { isReceiptInFlight } from '../../client/receipt-display';
  import ReceiptLines from './ReceiptLines.svelte';
  import ReceiptTotalsStrip from './ReceiptTotalsStrip.svelte';
  import type { ReceiptDetail, ReceiptLinePatch } from '../../shared/schemas';

  // The review surface's interactive base: the receipt's image, its lines with
  // their review states and edits, and the totals the edits move. Only a
  // receipt in `review` is editable — a committed receipt renders read-only —
  // and every edit carries the `updatedAt` the editor last saw, so a receipt
  // another device moved on answers with a conflict instead of a silent
  // overwrite.
  let {
    detail,
    writable = false,
    onSaved,
  }: {
    detail: ReceiptDetail;
    writable?: boolean;
    onSaved: (detail: ReceiptDetail) => void;
  } = $props();

  const editable = $derived(detail.status === 'review' && writable);

  let imageFailed = $state(false);
  let saving = $state(false);
  let saveError = $state('');
  /**
   * Saves run one at a time and in order. Blurring a field and pressing a state
   * control can both fire in the same moment, and the second edit must carry the
   * `updatedAt` the first one left behind, not the stale one it saw.
   */
  let queue: Promise<void> = Promise.resolve();

  function handleLineEdit(lineId: string, patch: ReceiptLinePatch): void {
    queue = queue.then(() => saveLine(lineId, patch));
  }

  async function saveLine(
    lineId: string,
    patch: ReceiptLinePatch,
  ): Promise<void> {
    saving = true;
    try {
      const updated = await saveReceiptReview(detail.id, {
        expectedUpdatedAt: detail.updatedAt,
        lines: [{ id: lineId, ...patch }],
      });
      saveError = '';
      onSaved(updated);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reloadAfterConflict();
      } else {
        saveError =
          error instanceof ApiError
            ? error.message
            : 'That edit could not be saved. Try again.';
      }
    } finally {
      saving = false;
    }
  }

  /** A conflict means someone else moved the receipt on: show their copy. */
  async function reloadAfterConflict(): Promise<void> {
    try {
      onSaved(await fetchReceiptDetail(detail.id));
      saveError =
        'This receipt changed on another device — the latest version is shown.';
    } catch {
      saveError = 'This receipt changed elsewhere. Refresh to see the latest.';
    }
  }
</script>

<figure class="receipt-image">
  {#if !detail.imageAvailable || imageFailed}
    <figcaption class="purged-note">
      Image purged — the text below is kept.
    </figcaption>
  {:else}
    <img
      src={`/api/receipts/${detail.id}/image`}
      alt="Scanned receipt"
      onerror={() => (imageFailed = true)}
    />
  {/if}
</figure>

{#if saveError}
  <p class="message error-message" role="alert">{saveError}</p>
{/if}

<h3 class="detail-subheading">Parsed lines</h3>
{#if detail.lines.length}
  <ReceiptLines
    lines={detail.lines}
    currency={detail.currency}
    {editable}
    {saving}
    onLineEdit={handleLineEdit}
  />
  {#if detail.status === 'review' && !writable}
    <p class="muted">
      Reviewing needs a connection — reconnect to edit this receipt.
    </p>
  {/if}
  <ReceiptTotalsStrip
    lines={detail.lines}
    subtotalMinor={detail.subtotalMinor}
    taxMinor={detail.taxMinor}
    totalMinor={detail.totalMinor}
    currency={detail.currency}
  />
{:else if isReceiptInFlight(detail.status)}
  <p class="muted">Reading the receipt… this updates automatically.</p>
{:else}
  <p class="muted">No lines were read from this receipt.</p>
{/if}

{#if detail.ocrText}
  <h3 class="detail-subheading">Raw OCR text</h3>
  <pre class="ocr-text">{detail.ocrText}</pre>
{/if}

<style>
  .receipt-image {
    margin: 0 0 1rem;
    padding: 0;
  }

  .receipt-image img {
    display: block;
    width: 100%;
    max-height: 60vh;
    object-fit: contain;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface-inset);
  }

  .purged-note {
    padding: 1.5rem 1rem;
    border: 1px dashed var(--line);
    border-radius: 12px;
    color: var(--text-muted);
    text-align: center;
  }

  .detail-subheading {
    margin: 1rem 0 0.5rem;
    font-size: 0.95rem;
  }

  .ocr-text {
    margin: 0;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface-inset);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
