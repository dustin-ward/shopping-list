<script lang="ts">
  import { ApiError } from '../../client/api';
  import {
    bindItemEdit,
    draftItemEdit,
    releaseEdit,
    storePrefill,
    suggestionEdit,
    type CatalogItemOption,
    type GroupOption,
  } from '../../client/receipt-binding';
  import {
    fetchReceiptDetail,
    saveReceiptReview,
  } from '../../client/receipt-review';
  import { isReceiptInFlight } from '../../client/receipt-display';
  import ReceiptLines from './ReceiptLines.svelte';
  import ReceiptStorePicker from './ReceiptStorePicker.svelte';
  import ReceiptTotalsStrip from './ReceiptTotalsStrip.svelte';
  import type {
    ReceiptDetail,
    ReceiptDetailLine,
    ReceiptLinePatch,
    ReceiptSuggestion,
    UpdateReceiptInput,
  } from '../../shared/schemas';

  // The review surface's interactive base: the receipt's image, its lines with
  // their review states, bindings and edits, the store it belongs to, and the
  // totals the edits move. Only a receipt in `review` is editable — a committed
  // receipt renders read-only — and every edit carries the `updatedAt` the
  // editor last saw, so a receipt another device moved on answers with a
  // conflict instead of a silent overwrite.
  //
  // The household's items and store groups arrive from the page's snapshot: the
  // item search and the store picker are reads of the same list the reviewer
  // sees. An inline-created item or store is only a draft held here until
  // commit (ticket 13) materializes it, which is why this component never asks
  // the server for one.
  let {
    detail,
    writable = false,
    catalogItems = [],
    groups = [],
    onSaved,
  }: {
    detail: ReceiptDetail;
    writable?: boolean;
    catalogItems?: readonly CatalogItemOption[];
    groups?: readonly GroupOption[];
    onSaved: (detail: ReceiptDetail) => void;
  } = $props();

  const editable = $derived(detail.status === 'review' && writable);
  const stores = $derived(groups.filter((group) => group.kind === 'store'));

  let imageFailed = $state(false);
  let saving = $state(false);
  let saveError = $state('');
  /**
   * Saves run one at a time and in order. Blurring a field, pressing a state
   * control and accepting a chip can all fire in the same moment, and the second
   * edit must carry the `updatedAt` the first one left behind, not the stale one
   * it saw.
   */
  let queue: Promise<void> = Promise.resolve();

  /**
   * Drafts created inline: the reviewer's names for an item and a store that do
   * not exist yet. They live here, and only here, until commit materializes
   * them — no catalog item and no store group is written early.
   */
  let itemDrafts = $state<Record<string, string>>({});
  let storeDraft = $state('');
  /** The store the receipt's own text names, while the reviewer has chosen none. */
  const storeSuggestion = $derived(
    !detail.storeGroupId && !storeDraft
      ? storePrefill(detail.lines, stores)
      : null,
  );

  /**
   * Send one line's edit. Any state but `new` ends the line's item draft, so a
   * released or re-bound line cannot still be holding a name for nothing.
   */
  function submitLine(lineId: string, patch: ReceiptLinePatch): void {
    if (patch.reviewState && patch.reviewState !== 'new') {
      forgetItemDraft(lineId);
    }
    queue = queue.then(() => save({ lines: [{ id: lineId, ...patch }] }));
  }

  function acceptSuggestion(
    line: ReceiptDetailLine,
    suggestion: ReceiptSuggestion,
  ): void {
    const patch = suggestionEdit(line, suggestion);
    if (patch) submitLine(line.id, patch);
  }

  function bindItem(lineId: string, catalogItemId: string): void {
    submitLine(lineId, bindItemEdit(catalogItemId));
  }

  function releaseLine(lineId: string): void {
    submitLine(lineId, releaseEdit());
  }

  /** Start (or keep editing) a draft item for the line. */
  function draftItem(lineId: string): void {
    const line = detail.lines.find((candidate) => candidate.id === lineId);
    if (!line) return;
    const { patch, name } = draftItemEdit(line);
    itemDrafts = { ...itemDrafts, [lineId]: name };
    if (line.reviewState !== 'new') submitLine(lineId, patch);
  }

  function renameDraftItem(lineId: string, name: string): void {
    itemDrafts = { ...itemDrafts, [lineId]: name };
  }

  function forgetItemDraft(lineId: string): void {
    if (!(lineId in itemDrafts)) return;
    const { [lineId]: _dropped, ...rest } = itemDrafts;
    itemDrafts = rest;
  }

  /** Pick an existing store: an ordinary edit, persisted like any other. */
  function chooseStore(storeGroupId: string | null): void {
    storeDraft = '';
    queue = queue.then(() => save({ storeGroupId }));
  }

  /**
   * Draft a brand-new store. Only one of the two can stand — a receipt is bound
   * to a group or it is waiting on a draft — so drafting unset whatever group was
   * chosen, and commit (ticket 13) is what materializes the draft instead.
   */
  function draftStore(name: string): void {
    storeDraft = name;
    if (detail.storeGroupId) {
      queue = queue.then(() => save({ storeGroupId: null }));
    }
  }

  async function save(patch: Omit<UpdateReceiptInput, 'expectedUpdatedAt'>) {
    saving = true;
    try {
      const updated = await saveReceiptReview(detail.id, {
        expectedUpdatedAt: detail.updatedAt,
        ...patch,
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
    {catalogItems}
    drafts={itemDrafts}
    onLineEdit={submitLine}
    onSuggestion={acceptSuggestion}
    onBindItem={bindItem}
    onDraftItem={draftItem}
    onDraftName={renameDraftItem}
    onRelease={releaseLine}
  />
  {#if detail.status === 'review' && !writable}
    <p class="muted">
      Reviewing needs a connection — reconnect to edit this receipt.
    </p>
  {/if}
  <h3 class="detail-subheading">Store</h3>
  <ReceiptStorePicker
    {stores}
    storeGroupId={detail.storeGroupId}
    draftName={storeDraft}
    prefill={storeSuggestion}
    {editable}
    onChoose={chooseStore}
    onDraft={draftStore}
    onClearDraft={() => (storeDraft = '')}
  />
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
