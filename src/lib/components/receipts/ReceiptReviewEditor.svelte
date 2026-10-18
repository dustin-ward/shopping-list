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
    commitBlocker,
    commitErrorMessage,
    commitReceiptInput,
    discardErrorMessage,
    submitReceiptCommit,
    submitReceiptDiscard,
  } from '../../client/receipt-commit';
  import {
    fetchReceiptDetail,
    saveReceiptReview,
  } from '../../client/receipt-review';
  import {
    repairBindPatch,
    repairErrorMessage,
    repairReceiptInput,
    repairStatePatch,
    repairSuggestionPatch,
    submitReceiptRepair,
  } from '../../client/receipt-repair';
  import { isReceiptInFlight } from '../../client/receipt-display';
  import ReceiptLines from './ReceiptLines.svelte';
  import ReceiptStorePicker from './ReceiptStorePicker.svelte';
  import ReceiptTotalsStrip from './ReceiptTotalsStrip.svelte';
  import type {
    ReceiptDetail,
    ReceiptDetailLine,
    ReceiptLinePatch,
    ReceiptSuggestion,
    RepairLinePatch,
    UpdateReceiptInput,
  } from '../../shared/schemas';
  import type { ReviewStateAction } from '../../shared/receipt-review';

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
    onSettled,
  }: {
    detail: ReceiptDetail;
    writable?: boolean;
    catalogItems?: readonly CatalogItemOption[];
    groups?: readonly GroupOption[];
    onSaved: (detail: ReceiptDetail) => void;
    /** The receipt left the review queue: the list around it may need a refresh. */
    onSettled?: (detail: ReceiptDetail) => void;
  } = $props();

  const editable = $derived(detail.status === 'review' && writable);
  const stores = $derived(groups.filter((group) => group.kind === 'store'));
  /** Discard stands from any status but the two it cannot change. */
  const discardable = $derived(
    writable && detail.status !== 'committed' && detail.status !== 'discarded',
  );
  /**
   * Repair (ticket 16) is offered on a committed receipt the page can write —
   * and only when there is an item line whose binding it could move.
   */
  const canRepair = $derived(
    writable &&
      detail.status === 'committed' &&
      detail.lines.some((line) => line.isItemChunk),
  );

  let imageFailed = $state(false);
  let saving = $state(false);
  let saveError = $state('');
  /** The commit or discard in flight, and the refusal it came back with. */
  let committing = $state(false);
  let discarding = $state(false);
  let actionError = $state('');
  /** Discard asks twice: the first tap only arms the confirm. */
  let confirmingDiscard = $state(false);
  /** Repair is an explicit mode, entered through its own two-tap confirm. */
  let repairing = $state(false);
  let confirmingRepair = $state(false);
  /** Every write to this receipt is refused while one is in flight. */
  const busy = $derived(saving || committing || discarding);
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
  /**
   * Why commit is not available yet, or `null` when it is. The server's plan is
   * the authority; this is what keeps the button disabled and says why.
   */
  const blocker = $derived(
    editable ? commitBlocker(detail, { itemDrafts, storeDraft }) : null,
  );
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
        await reloadAfterConflict(
          'This receipt changed on another device — the latest version is shown.',
        );
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
  async function reloadAfterConflict(message: string): Promise<void> {
    saveError = message;
    try {
      onSaved(await fetchReceiptDetail(detail.id));
    } catch {
      saveError = 'This receipt changed elsewhere. Refresh to see the latest.';
    }
  }

  /**
   * Repair one committed line's binding. It rides the same save queue and
   * carries the `updatedAt` the editor last saw, so a correction made from a
   * stale view is refused rather than landing on someone else's newer one.
   */
  function submitRepair(lineId: string, patch: RepairLinePatch): void {
    queue = queue.then(() => saveRepair(lineId, patch));
  }

  async function saveRepair(
    lineId: string,
    patch: RepairLinePatch,
  ): Promise<void> {
    saving = true;
    try {
      const updated = await submitReceiptRepair(
        detail.id,
        repairReceiptInput(detail, lineId, patch),
      );
      saveError = '';
      onSaved(updated);
    } catch (error) {
      const message = repairErrorMessage(error);
      if (error instanceof ApiError && error.code === 'RECEIPT_CHANGED') {
        await reloadAfterConflict(message);
      } else {
        saveError = message;
      }
    } finally {
      saving = false;
    }
  }

  /** A tap that sets an unidentified state; the same state is not a repair. */
  function repairState(lineId: string, action: ReviewStateAction): void {
    const line = detail.lines.find((candidate) => candidate.id === lineId);
    if (!line) return;
    const patch = repairStatePatch(line, action);
    if (patch) submitRepair(lineId, patch);
  }

  /** A tap on an offered candidate; the line's own chip is not a repair. */
  function repairSuggestion(
    line: ReceiptDetailLine,
    suggestion: ReceiptSuggestion,
  ): void {
    const patch = repairSuggestionPatch(line, suggestion);
    if (patch) submitRepair(line.id, patch);
  }

  /** A pick from the item search; the line's current item is not a repair. */
  function repairBind(lineId: string, catalogItemId: string): void {
    const line = detail.lines.find((candidate) => candidate.id === lineId);
    if (!line) return;
    const patch = repairBindPatch(line, catalogItemId);
    if (patch) submitRepair(lineId, patch);
  }

  /** Enter repair mode: explicit, and only from the confirm. */
  function startRepair(): void {
    confirmingRepair = false;
    repairing = true;
    saveError = '';
    actionError = '';
  }

  /** Leave repair mode; every correction already landed on the server. */
  function stopRepair(): void {
    repairing = false;
  }

  /**
   * Commit the reviewed receipt. The save queue drains first: the request is
   * guarded by the `updatedAt` the editor last saw, so an edit still in flight
   * would make this commit stale by its own hand. The drafts go with it — a
   * name the reviewer typed is not a row until the server materializes it — and
   * what comes back is a committed receipt, read-only from here on.
   */
  async function commit(): Promise<void> {
    if (committing || blocker) return;
    actionError = '';
    committing = true;
    try {
      await queue;
      const updated = await submitReceiptCommit(
        detail.id,
        commitReceiptInput(detail, { itemDrafts, storeDraft }),
      );
      itemDrafts = {};
      storeDraft = '';
      saveError = '';
      onSaved(updated);
      onSettled?.(updated);
    } catch (error) {
      const message = commitErrorMessage(error);
      if (
        error instanceof ApiError &&
        (error.code === 'RECEIPT_CHANGED' ||
          error.code === 'RECEIPT_ALREADY_COMMITTED')
      ) {
        // Someone else committed it, or edited it: show their copy.
        await refreshAfterConflict(message);
      } else {
        actionError = message;
      }
    } finally {
      committing = false;
    }
  }

  /**
   * Discard the receipt: two taps, because the image is gone for good. What is
   * kept is the audit trail — the OCR text and the parsed lines — which is why
   * the reviewer is told exactly that before they confirm.
   */
  async function discard(): Promise<void> {
    if (discarding) return;
    actionError = '';
    confirmingDiscard = false;
    discarding = true;
    try {
      await queue;
      const updated = await submitReceiptDiscard(detail.id);
      onSaved(updated);
      onSettled?.(updated);
    } catch (error) {
      const message = discardErrorMessage(error);
      if (error instanceof ApiError && error.code === 'RECEIPT_COMMITTED') {
        await refreshAfterConflict(message);
      } else {
        actionError = message;
      }
    } finally {
      discarding = false;
    }
  }

  /**
   * The receipt moved on under us: show the server's copy, since the local one
   * is what the refusal was about. The message stays, so the reviewer knows why
   * their commit or discard did not take.
   */
  async function refreshAfterConflict(message: string): Promise<void> {
    actionError = message;
    try {
      onSaved(await fetchReceiptDetail(detail.id));
    } catch {
      // The message already says what happened; a manual refresh still works.
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

{#if actionError}
  <p class="message error-message" role="alert">{actionError}</p>
{/if}

<h3 class="detail-subheading">Parsed lines</h3>
{#if canRepair}
  <div class="repair-row">
    {#if repairing}
      <p class="repair-banner" role="status">
        Repairing the binding — the printed text, the prices and the photo stay
        as committed.
      </p>
      <button
        type="button"
        class="repair-done-button"
        disabled={busy}
        onclick={stopRepair}
      >
        Done repairing
      </button>
    {:else if confirmingRepair}
      <p class="repair-confirm" role="status">
        Repair a line's binding? Price history and aliases follow the fix; the
        printed text, the prices and the photo are kept.
      </p>
      <div class="repair-actions">
        <button
          type="button"
          class="confirm-repair-button"
          disabled={busy}
          onclick={startRepair}
        >
          Start repair
        </button>
        <button
          type="button"
          class="repair-cancel-button"
          disabled={busy}
          onclick={() => (confirmingRepair = false)}
        >
          Cancel
        </button>
      </div>
    {:else}
      <button
        type="button"
        class="repair-button"
        disabled={busy}
        onclick={() => (confirmingRepair = true)}
      >
        Repair binding
      </button>
    {/if}
  </div>
{/if}
{#if detail.lines.length}
  <ReceiptLines
    lines={detail.lines}
    currency={detail.currency}
    {editable}
    {repairing}
    saving={busy}
    {catalogItems}
    drafts={itemDrafts}
    onLineEdit={submitLine}
    onSuggestion={acceptSuggestion}
    onBindItem={bindItem}
    onDraftItem={draftItem}
    onDraftName={renameDraftItem}
    onRelease={releaseLine}
    onRepairState={repairState}
    onRepairSuggestion={repairSuggestion}
    onRepairBind={repairBind}
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

{#if editable}
  <div class="commit-row">
    <button
      type="button"
      class="commit-button"
      disabled={busy || blocker !== null}
      onclick={commit}
    >
      {committing ? 'Committing…' : 'Commit receipt'}
    </button>
    {#if blocker}
      <!-- Why the button is disabled, in the reviewer's words. -->
      <p class="commit-blocker" role="status">{blocker}</p>
    {/if}
  </div>
{/if}

{#if discardable}
  <div class="discard-row">
    {#if confirmingDiscard}
      <p class="discard-confirm" role="status">
        Discard this receipt? The photo is deleted; the text and lines are kept.
      </p>
      <div class="discard-actions">
        <button
          type="button"
          class="confirm-discard-button"
          disabled={busy}
          onclick={discard}
        >
          {discarding ? 'Discarding…' : 'Confirm discard'}
        </button>
        <button
          type="button"
          class="discard-cancel-button"
          disabled={busy}
          onclick={() => (confirmingDiscard = false)}
        >
          Cancel
        </button>
      </div>
    {:else}
      <button
        type="button"
        class="discard-button"
        disabled={busy}
        onclick={() => (confirmingDiscard = true)}
      >
        Discard receipt
      </button>
    {/if}
  </div>
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

  /* The write path's two actions, set apart from the review edits above them. */
  .commit-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1.1rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--line);
  }

  .commit-button {
    min-height: 2.8rem;
    padding: 0.6rem 1rem;
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--page-bg);
    background: var(--accent);
    font-family: var(--font-display);
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .commit-button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .commit-blocker {
    flex: 1 1 12rem;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .discard-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.85rem;
  }

  /* The confirm reads before the buttons, so the tap cannot be a surprise. */
  .discard-confirm {
    flex: 1 0 100%;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .discard-actions {
    display: flex;
    gap: 0.5rem;
  }

  .discard-button,
  .confirm-discard-button,
  .discard-cancel-button,
  .repair-button,
  .confirm-repair-button,
  .repair-cancel-button,
  .repair-done-button {
    min-height: 2.4rem;
    padding: 0.5rem 0.8rem;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--text);
    background: transparent;
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 650;
    letter-spacing: 0.015em;
    text-transform: uppercase;
  }

  .confirm-discard-button {
    border-color: var(--danger);
    color: var(--danger);
  }

  .discard-button:disabled,
  .confirm-discard-button:disabled,
  .discard-cancel-button:disabled,
  .repair-button:disabled,
  .confirm-repair-button:disabled,
  .repair-cancel-button:disabled,
  .repair-done-button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  /* Repair is a mode, so it sits above the lines it makes interactive. */
  .repair-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }

  .confirm-repair-button {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* The confirm reads before the buttons, so the tap cannot be a surprise. */
  .repair-confirm,
  .repair-banner {
    flex: 1 0 100%;
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .repair-actions {
    display: flex;
    gap: 0.5rem;
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
