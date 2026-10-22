<script lang="ts">
  import { onMount } from 'svelte';
  import {
    lastPaidWhen,
    perUnitLabel,
    sparkline,
    SPARKLINE_HEIGHT,
    SPARKLINE_WIDTH,
    trendReading,
  } from '../../client/item-prices';
  import { formatMoney } from '../../client/money';
  import type { ItemPrices, PriceFamily } from '../../shared/schemas';

  // The item-detail Prices sheet (ticket 21; plan §10 "Item detail entry
  // points"): what this household last paid at each store, one trend per
  // measurement family, and a way back to the committed receipt that holds the
  // price. The server's aggregates come from ticket 20 — this component only
  // renders them, so a store row can never quietly compare a pound to an each.
  //
  // It owns the modal affordance (showModal, Esc/close reaching the page) and
  // nothing else: the read, its retry and the receipt navigation belong to the
  // container that mounts it.
  let {
    item,
    prices = null,
    loading = false,
    error = '',
    now = new Date(),
    onClose = () => {},
    onOpenReceipt = () => {},
    onRetry = () => {},
  }: {
    item: { id: string; name: string };
    prices?: ItemPrices | null;
    loading?: boolean;
    error?: string;
    /** The moment "today" means; pinned by tests, defaulted for the browser. */
    now?: Date;
    onClose?: () => void;
    onOpenReceipt?: (receiptId: string) => void;
    /** Re-read the history after a failure; the container owns the request. */
    onRetry?: () => void;
  } = $props();

  const FAMILY_NAMES: Record<PriceFamily, string> = {
    mass: 'Mass',
    volume: 'Volume',
    count: 'Count',
  };

  let dialog = $state<HTMLDialogElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    if (dialog && !dialog.open) {
      dialog.showModal();
      closeButton?.focus();
    }
  });

  function countLabel(count: number, singular: string, plural: string): string {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  const summary = $derived.by(() => {
    if (!prices || prices.stores.length === 0) return '';
    return `${countLabel(prices.receiptCount, 'committed receipt', 'committed receipts')} · ${countLabel(prices.lineCount, 'line', 'lines')} · ${formatMoney(prices.spendMinor, prices.currency)} spent`;
  });
</script>

<dialog
  class="prices-sheet"
  aria-labelledby="prices-heading"
  bind:this={dialog}
  onclose={onClose}
>
  <div class="prices-content">
    <header class="prices-heading">
      <div>
        <p class="eyebrow">Committed receipts</p>
        <h2 id="prices-heading">Prices for {item.name}</h2>
        {#if summary}
          <p class="prices-summary">{summary}</p>
        {/if}
      </div>
      <button
        class="quiet-button prices-close"
        type="button"
        bind:this={closeButton}
        onclick={() => dialog?.close()}
      >
        Close
      </button>
    </header>

    {#if error}
      <div class="prices-error">
        <p class="message error-message" role="alert">{error}</p>
        <button
          class="secondary-button prices-retry"
          type="button"
          onclick={onRetry}
        >
          Try again
        </button>
      </div>
    {/if}

    {#if loading && !prices}
      <p class="empty-list">Loading prices…</p>
    {:else if prices}
      {#if prices.stores.length === 0}
        <p class="prices-empty">
          <strong>No committed receipts yet.</strong>
          Prices appear here once a receipt with this item is committed.
        </p>
      {:else}
        <ul class="price-store-list">
          {#each prices.stores as store (store.storeGroupId)}
            <li class="price-store">
              <div class="price-store-heading">
                <h3>{store.storeName}</h3>
                <p class="price-last-paid">
                  {#if store.lastPaidMinor !== null}
                    Last paid {formatMoney(
                      store.lastPaidMinor,
                      prices.currency,
                    )}
                    {lastPaidWhen(store.lastPaidAt, now)}
                  {:else}
                    Last paid amount not recorded
                  {/if}
                </p>
              </div>

              {#if store.families.length}
                {#each store.families as family (family.family)}
                  {@const reading = trendReading(family.trend)}
                  {@const line = sparkline(
                    family.history.map((pricePoint) => ({
                      value: pricePoint.normalizedUnitPriceMinor,
                      at: pricePoint.receiptCreatedAt,
                    })),
                  )}
                  {@const unit = perUnitLabel(family.unit)}
                  <div class="price-family" data-family={family.family}>
                    <div class="price-family-heading">
                      <span class="price-family-name"
                        >{FAMILY_NAMES[family.family]}</span
                      >
                      <span class="price-unit">
                        {formatMoney(
                          family.lastUnitPriceMinor,
                          prices.currency,
                        )}
                        {unit}
                      </span>
                    </div>
                    <div class="price-family-body">
                      <svg
                        class="price-sparkline"
                        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={family.history.length > 1
                          ? `Unit price ${unit} across ${countLabel(
                              family.history.length,
                              'receipt',
                              'receipts',
                            )} at ${store.storeName}`
                          : `One recorded unit price ${unit} at ${store.storeName}`}
                      >
                        {#if family.history.length > 1}
                          <polyline
                            points={line.points}
                            fill="none"
                            vector-effect="non-scaling-stroke"
                          />
                        {/if}
                        {#if line.last}
                          <circle cx={line.last.x} cy={line.last.y} r="2" />
                        {/if}
                      </svg>
                      <div class="price-family-readout">
                        <p class="price-trend" data-trend={family.trend}>
                          <span aria-hidden="true">{reading.arrow}</span>
                          {reading.label}
                        </p>
                        <p class="price-range">
                          Low {formatMoney(
                            family.minUnitPriceMinor,
                            prices.currency,
                          )} · High {formatMoney(
                            family.maxUnitPriceMinor,
                            prices.currency,
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                {/each}
              {:else}
                <p class="price-no-family">
                  No comparable unit price yet — these lines have no unit that
                  can be normalized.
                </p>
              {/if}

              <button
                class="quiet-button price-receipt-link"
                type="button"
                aria-label={`Open receipt from ${store.storeName}`}
                onclick={() => onOpenReceipt(store.lastReceiptId)}
              >
                Open receipt
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</dialog>

<style>
  .prices-sheet {
    width: min(100% - 2rem, 34rem);
    max-height: min(80vh, 40rem);
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
  }

  .prices-sheet::backdrop {
    background: rgb(8 10 9 / 72%);
  }

  .prices-content {
    display: grid;
    gap: 0.9rem;
    padding: 1rem 1.1rem 1.2rem;
  }

  .prices-heading {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--line);
  }

  .prices-heading h2,
  .prices-heading p {
    margin: 0;
  }

  .prices-heading h2 {
    font-size: 1.15rem;
  }

  .eyebrow {
    margin: 0 0 0.2rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .prices-summary {
    margin-top: 0.3rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .prices-close {
    flex: none;
  }

  .prices-error {
    display: grid;
    gap: 0.5rem;
    justify-items: start;
  }

  .prices-error p {
    margin: 0;
  }

  .prices-empty,
  .price-no-family {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .prices-empty strong {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--text);
  }

  .price-store-list {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .price-store {
    display: grid;
    gap: 0.55rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface-inset);
  }

  .price-store-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 0.75rem;
  }

  .price-store-heading h3 {
    margin: 0;
    font-size: 0.95rem;
  }

  .price-last-paid {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .price-family {
    display: grid;
    gap: 0.3rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--line);
  }

  .price-family-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .price-family-name {
    color: var(--text-muted);
    font-size: 0.75rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .price-unit {
    font-family: var(--font-display);
    font-size: 0.9rem;
  }

  .price-family-body {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .price-sparkline {
    width: 7.5rem;
    height: 2rem;
    flex: none;
  }

  .price-sparkline polyline {
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .price-sparkline circle {
    fill: var(--accent);
  }

  .price-family-readout {
    display: grid;
    gap: 0.15rem;
  }

  .price-trend,
  .price-range {
    margin: 0;
    font-size: 0.78rem;
  }

  .price-trend {
    color: var(--text);
  }

  .price-trend[data-trend='down'] {
    color: var(--success);
  }

  .price-trend[data-trend='up'] {
    color: var(--danger);
  }

  .price-trend[data-trend='unknown'] {
    color: var(--text-muted);
  }

  .price-range {
    color: var(--text-muted);
  }

  .price-receipt-link {
    justify-self: start;
  }
</style>
