<script lang="ts">
  import { onMount } from 'svelte';
  import { ApiError, requestJson } from '../../client/api';
  import { prepareReceiptImage } from '../../client/receipt-image';
  import {
    receiptUploadErrorMessage,
    uploadReceipt,
  } from '../../client/receipt-upload';
  import type {
    ReceiptDetail,
    ReceiptListItem,
    ReceiptListPage,
    ReceiptStatus,
  } from '../../shared/schemas';

  // Capture writes to the server, so the page hands down the existing `canWrite`
  // rule (online, no pending action) rather than re-deriving connectivity here.
  let { writable = false }: { writable?: boolean } = $props();

  const STATUS_LABELS: Record<ReceiptStatus, string> = {
    pending: 'Pending',
    processing: 'Processing',
    review: 'Review needed',
    committed: 'Committed',
    discarded: 'Discarded',
    failed: 'Failed',
  };

  const FILTERS: { value: ReceiptStatus | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'review', label: 'Review needed' },
    { value: 'committed', label: 'Committed' },
    { value: 'failed', label: 'Failed' },
  ];

  /** Light poll while a receipt is still being read; the plan budgets ~3 s. */
  const POLL_INTERVAL_MS = 3000;

  let items = $state<ReceiptListItem[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let loaded = $state(false);
  let listError = $state('');
  let statusFilter = $state<ReceiptStatus | 'all'>('all');
  let hasUnknownsOnly = $state(false);
  /** The page request in flight, so a caller can wait for it to drain. */
  let loadInFlight: Promise<void> | null = null;

  let selectedId = $state<string | null>(null);
  let detail = $state<ReceiptDetail | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');
  let imageFailed = $state(false);
  let detailRefreshing = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  let captureInput = $state<HTMLInputElement | null>(null);
  let capturing = $state(false);
  let captureStatus = $state('');
  let captureProgress = $state<number | null>(null);
  let captureNotice = $state('');
  let captureError = $state('');

  onMount(() => {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void loadPage(true);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stopPolling();
    };
  });

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'visible' && selectedId) {
      void refreshDetail();
    }
  }

  function loadPage(reset: boolean): Promise<void> {
    if (loadInFlight) return loadInFlight;
    loadInFlight = fetchPage(reset).finally(() => {
      loadInFlight = null;
    });
    return loadInFlight;
  }

  async function fetchPage(reset: boolean): Promise<void> {
    loading = true;
    listError = '';
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (hasUnknownsOnly) params.set('hasUnknowns', 'true');
      if (!reset && nextCursor) params.set('cursor', nextCursor);
      const query = params.toString();
      const page = await requestJson<ReceiptListPage>(
        `/api/receipts${query ? `?${query}` : ''}`,
      );
      items = reset ? page.items : [...items, ...page.items];
      nextCursor = page.nextCursor;
      loaded = true;
    } catch (error) {
      listError =
        error instanceof ApiError
          ? error.message
          : 'Receipts are unavailable. Refresh and try again.';
    } finally {
      loading = false;
    }
  }

  function selectFilter(value: ReceiptStatus | 'all'): void {
    if (statusFilter === value) return;
    statusFilter = value;
    void loadPage(true);
  }

  function toggleUnknowns(): void {
    hasUnknownsOnly = !hasUnknownsOnly;
    void loadPage(true);
  }

  function openCapture(): void {
    captureInput?.click();
  }

  /**
   * The whole capture moment: compress on the device, upload with progress, then
   * refresh the list so the new pending receipt is visible without a reload.
   */
  async function handleFileChosen(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    // Reset so picking the same photo again still fires a change event.
    input.value = '';
    if (!file) return;

    capturing = true;
    captureError = '';
    captureNotice = '';
    captureProgress = null;
    captureStatus = 'Compressing the photo…';
    try {
      const prepared = await prepareReceiptImage(file);
      captureStatus = 'Uploading the receipt…';
      const result = await uploadReceipt(prepared.blob, {
        onProgress: (fraction) => {
          captureProgress = Math.round(fraction * 100);
        },
      });
      captureNotice = result.alreadyCaptured
        ? 'That receipt was already captured — it is already in the list.'
        : 'Receipt captured. It appears in the list as pending.';
      // A new capture must be visible even while a filter is active, and a page
      // request that began before the upload cannot contain the new receipt —
      // let it drain, then fetch a page that does.
      statusFilter = 'all';
      hasUnknownsOnly = false;
      await loadInFlight;
      await loadPage(true);
    } catch (error) {
      captureError = receiptUploadErrorMessage(error);
    } finally {
      capturing = false;
      captureStatus = '';
      captureProgress = null;
    }
  }

  async function openDetail(id: string): Promise<void> {
    selectedId = id;
    detail = null;
    detailError = '';
    imageFailed = false;
    stopPolling();
    await refreshDetail();
  }

  async function refreshDetail(): Promise<void> {
    const id = selectedId;
    if (!id || detailRefreshing) return;
    detailRefreshing = true;
    detailLoading = true;
    try {
      const value = await requestJson<ReceiptDetail>(`/api/receipts/${id}`);
      if (selectedId !== id) return;
      detail = value;
      detailError = '';
      syncPoll(value.status);
    } catch (error) {
      if (selectedId !== id) return;
      detailError =
        error instanceof ApiError
          ? error.message
          : 'This receipt could not be loaded.';
      stopPolling();
    } finally {
      detailRefreshing = false;
      detailLoading = false;
    }
  }

  /** A receipt still being read must be polled; a settled one must not. */
  function isInFlight(status: ReceiptStatus): boolean {
    return status === 'pending' || status === 'processing';
  }

  function syncPoll(status: ReceiptStatus): void {
    if (isInFlight(status)) startPolling();
    else stopPolling();
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshDetail();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function closeDetail(): void {
    stopPolling();
    selectedId = null;
    detail = null;
    imageFailed = false;
    void loadPage(true);
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  function formatMoney(minor: number, currency: string | null): string {
    return new Intl.NumberFormat([], {
      style: 'currency',
      currency: currency ?? 'USD',
    }).format(minor / 100);
  }
</script>

<section
  class="secondary-screen receipts-screen"
  aria-labelledby="receipts-heading"
>
  <div class="list-heading">
    <div>
      <p class="eyebrow">Photographed purchases</p>
      <h2 id="receipts-heading">Receipts</h2>
    </div>
  </div>

  {#if selectedId}
    <div class="receipt-detail">
      <button
        class="quiet-button back-button"
        type="button"
        onclick={closeDetail}
      >
        ← Back to receipts
      </button>

      {#if detailError}
        <p class="message error-message" role="alert">{detailError}</p>
      {/if}

      {#if detail}
        <div class="detail-header">
          <span class="status-chip status-{detail.status}"
            >{STATUS_LABELS[detail.status]}</span
          >
          <span class="muted">{formatDate(detail.createdAt)}</span>
          {#if detail.totalMinor !== null}
            <span class="detail-total"
              >{formatMoney(detail.totalMinor, detail.currency)}</span
            >
          {/if}
        </div>

        {#if detail.lastError}
          <p class="message error-message" role="alert">{detail.lastError}</p>
        {/if}

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

        <h3 class="detail-subheading">Raw OCR text</h3>
        {#if detail.ocrText}
          <pre class="ocr-text">{detail.ocrText}</pre>
        {:else if isInFlight(detail.status)}
          <p class="muted">Waiting for OCR… this updates automatically.</p>
        {:else}
          <p class="muted">No OCR text was recorded.</p>
        {/if}
      {:else if detailLoading}
        <p class="empty-list">Loading receipt…</p>
      {/if}
    </div>
  {:else}
    {#if writable}
      <div class="capture-row">
        <button
          class="capture-button"
          type="button"
          disabled={capturing}
          onclick={openCapture}
        >
          {capturing ? 'Preparing photo…' : 'Capture receipt'}
        </button>
        <input
          bind:this={captureInput}
          class="capture-input"
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Capture receipt photo"
          onchange={handleFileChosen}
        />
      </div>
    {/if}

    {#if capturing}
      <p class="capture-progress" role="status">
        <span>{captureStatus}</span>
        {#if captureProgress !== null}
          <progress max="100" value={captureProgress}></progress>
          <span>{captureProgress}%</span>
        {/if}
      </p>
    {/if}

    {#if captureError}
      <p class="capture-error" role="alert">{captureError}</p>
    {/if}

    {#if captureNotice}
      <p class="capture-notice" role="status">{captureNotice}</p>
    {/if}

    <div class="receipt-filters" role="group" aria-label="Filter receipts">
      {#each FILTERS as filter (filter.value)}
        <button
          type="button"
          class="filter-chip"
          class:active={statusFilter === filter.value}
          aria-pressed={statusFilter === filter.value}
          onclick={() => selectFilter(filter.value)}
        >
          {filter.label}
        </button>
      {/each}
      <button
        type="button"
        class="filter-chip unknown-filter"
        class:active={hasUnknownsOnly}
        aria-pressed={hasUnknownsOnly}
        onclick={toggleUnknowns}
      >
        Has unknowns
      </button>
    </div>

    {#if listError}
      <p class="message error-message" role="alert">{listError}</p>
    {/if}

    {#if items.length}
      <ul class="receipt-list">
        {#each items as item (item.id)}
          <li class="receipt-card">
            <button
              type="button"
              class="receipt-open"
              onclick={() => openDetail(item.id)}
            >
              <span class="status-chip status-{item.status}"
                >{STATUS_LABELS[item.status]}</span
              >
              <span class="receipt-copy">
                <span class="receipt-date">{formatDate(item.createdAt)}</span>
                {#if item.totalMinor !== null}
                  <span class="muted"
                    >{formatMoney(item.totalMinor, item.currency)}</span
                  >
                {/if}
              </span>
              {#if item.hasUnknowns}
                <span class="unknown-badge">Has unknowns</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if nextCursor}
        <button
          class="secondary-button load-more"
          type="button"
          disabled={loading}
          onclick={() => loadPage(false)}
        >
          {loading ? 'Loading…' : 'Load more receipts'}
        </button>
      {/if}
    {:else if loading && !loaded}
      <p class="empty-list">Loading receipts…</p>
    {:else if loaded && !listError}
      <p class="empty-list">
        {statusFilter !== 'all' || hasUnknownsOnly
          ? 'No receipts match these filters.'
          : 'No receipts captured yet.'}
      </p>
    {/if}
  {/if}
</section>

<style>
  .capture-row {
    display: flex;
    margin: 0.75rem 0 0.25rem;
  }

  .capture-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.9rem;
    padding: 0.65rem 1.1rem;
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--page-bg);
    background: var(--accent);
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .capture-button:hover:not(:disabled) {
    background: #e2b96f;
  }

  .capture-button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  /* The input stays in the accessibility tree; the button is the camera tap. */
  .capture-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .capture-progress {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.6rem 0 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .capture-error,
  .capture-notice {
    margin: 0.6rem 0 0;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--line);
    border-radius: 2px;
    font-size: 0.85rem;
  }

  .capture-error {
    border-color: #81564b;
    color: #f0c0b4;
    background: #30231f;
  }

  .capture-notice {
    border-color: #59684a;
    color: var(--success);
    background: #252b21;
  }

  .receipt-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.75rem 0 1rem;
  }

  .filter-chip {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-inset);
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .filter-chip.active {
    border-color: var(--line-bright);
    background: var(--accent-soft);
    color: var(--text);
  }

  .receipt-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .receipt-open {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.85rem 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    color: inherit;
    text-align: left;
  }

  .receipt-copy {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 0.15rem;
  }

  .receipt-date {
    font-weight: 600;
  }

  .status-chip {
    flex: none;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-inset);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .status-pending,
  .status-processing {
    border-color: var(--amber);
    color: var(--amber);
  }

  .status-review {
    border-color: var(--accent);
    color: var(--accent);
  }

  .status-committed {
    border-color: var(--success);
    color: var(--success);
  }

  .status-failed {
    border-color: var(--danger);
    color: var(--danger);
  }

  .unknown-badge {
    flex: none;
    padding: 0.2rem 0.5rem;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.72rem;
  }

  .back-button {
    margin-bottom: 0.75rem;
  }

  .detail-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .detail-total {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

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
