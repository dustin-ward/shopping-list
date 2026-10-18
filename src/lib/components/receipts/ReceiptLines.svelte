<script lang="ts">
  import {
    receiptLineView,
    suggestionIsBound,
    suggestionTierBadge,
  } from '../../client/receipt-display';
  import { formatMoney } from '../../client/money';
  import type { ReceiptDetailLine } from '../../shared/schemas';

  // Every parsed row is rendered, parked ones included: no-loss is a promise the
  // reviewer has to be able to see, not a database detail. Suggestions come from
  // the detail payload (tier 1 = the binding the line sits on, tier 2 = chips
  // that are shown but never applied).
  let {
    lines,
    currency = null,
  }: { lines: readonly ReceiptDetailLine[]; currency?: string | null } =
    $props();
</script>

{#if lines.length}
  <ul class="receipt-lines">
    {#each lines as line (line.id)}
      {@const view = receiptLineView(line)}
      {@const suggestions = line.suggestions ?? []}
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
        {#if suggestions.length}
          <ul class="line-suggestions" aria-label="Suggested items">
            {#each suggestions as suggestion (suggestion.catalogItemId)}
              {@const tier = suggestionTierBadge(suggestion.tier)}
              {@const bound = suggestionIsBound(line, suggestion)}
              <li class="suggestion-chip" class:bound title={tier.hint}>
                <span class="suggestion-name">{suggestion.name}</span>
                <span class="suggestion-tier">{tier.label}</span>
                {#if bound}
                  <span class="suggestion-bound">Bound</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
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
    flex-wrap: wrap;
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

  /* Candidate chips sit under the row's own text and figures. */
  .line-suggestions {
    display: flex;
    flex: 1 0 100%;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .suggestion-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-inset);
    font-size: 0.75rem;
  }

  /* The binding the line already sits on, so an auto-bind is never invisible. */
  .suggestion-chip.bound {
    border-color: var(--success);
    color: var(--success);
  }

  .suggestion-tier,
  .suggestion-bound {
    padding: 0 0.3rem;
    border-radius: 999px;
    background: var(--accent-soft);
    font-size: 0.66rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .suggestion-bound {
    background: none;
    border: 1px solid currentColor;
  }
</style>
