<script lang="ts">
  import { receiptLineView } from '../../client/receipt-display';
  import { formatMoney } from '../../client/money';
  import type { ReceiptLine } from '../../shared/schemas';

  // Every parsed row is rendered, parked ones included: no-loss is a promise the
  // reviewer has to be able to see, not a database detail.
  let {
    lines,
    currency = null,
  }: { lines: ReceiptLine[]; currency?: string | null } = $props();
</script>

{#if lines.length}
  <ul class="receipt-lines">
    {#each lines as line (line.id)}
      {@const view = receiptLineView(line)}
      <li class="receipt-line" class:parked={view.parked}>
        <div class="line-text">
          <span class="line-printed">{view.printedText}</span>
          {#if view.parsedName}
            <span class="line-parsed-name">{view.parsedName}</span>
          {/if}
        </div>
        <div class="line-figures">
          {#if view.parked}
            <span class="line-parked">Parked</span>
          {/if}
          {#if view.quantity}
            <span class="line-quantity">{view.quantity}</span>
          {/if}
          {#if view.unitPriceMinor !== null}
            <span class="line-unit-price"
              >{formatMoney(
                view.unitPriceMinor,
                currency,
              )}{view.unitPriceSuffix}</span
            >
          {/if}
          {#if view.totalPriceMinor !== null}
            <span class="line-total-price"
              >{formatMoney(view.totalPriceMinor, currency)}</span
            >
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .receipt-lines {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .receipt-line {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  /* Retained, but visibly not something that was bought. */
  .receipt-line.parked {
    border-style: dashed;
    background: var(--surface-inset);
    color: var(--text-muted);
  }

  .line-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.1rem;
    overflow-wrap: anywhere;
  }

  .line-printed {
    font-weight: 600;
  }

  .line-parsed-name {
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .line-figures {
    display: flex;
    flex: none;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }

  .line-parked {
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .line-quantity,
  .line-unit-price {
    color: var(--text-muted);
  }
</style>
