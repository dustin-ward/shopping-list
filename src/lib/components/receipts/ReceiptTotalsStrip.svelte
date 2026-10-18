<script lang="ts">
  import { formatMoney } from '../../client/money';
  import { totalsWarningText } from '../../client/receipt-display';
  import { receiptTotals } from '../../shared/receipt-totals';
  import type { ReceiptLine } from '../../shared/schemas';

  // The reconciliation strip: what the item lines add up to against what the
  // receipt prints. The delta is a warning only — it never blocks a commit — and
  // it is shown only once it exceeds max($0.05, 1% of the total).
  let {
    lines,
    subtotalMinor = null,
    taxMinor = null,
    totalMinor = null,
    currency = null,
  }: {
    lines: ReceiptLine[];
    subtotalMinor?: number | null;
    taxMinor?: number | null;
    totalMinor?: number | null;
    currency?: string | null;
  } = $props();

  const totals = $derived(
    receiptTotals({ lines, subtotalMinor, taxMinor, totalMinor }),
  );
  const warning = $derived(
    totalsWarningText(totals, (minor) => formatMoney(minor, currency)),
  );
  const hasAnything = $derived(
    totals.itemsMinor !== null ||
      totals.subtotalMinor !== null ||
      totals.taxMinor !== null ||
      totals.totalMinor !== null,
  );

  /** A receipt that prints no total shows a dash rather than a guess. */
  function money(minor: number | null): string {
    return minor === null ? '—' : formatMoney(minor, currency);
  }
</script>

{#if hasAnything}
  <section class="totals-strip" aria-label="Receipt totals">
    <dl class="totals-rows">
      <div class="totals-row">
        <dt>Item lines</dt>
        <dd class="totals-items">{money(totals.itemsMinor)}</dd>
      </div>
      <div class="totals-row">
        <dt>Subtotal</dt>
        <dd class="totals-subtotal">{money(totals.subtotalMinor)}</dd>
      </div>
      {#if totals.taxMinor !== null}
        <div class="totals-row">
          <dt>Tax</dt>
          <dd class="totals-tax">{money(totals.taxMinor)}</dd>
        </div>
      {/if}
      <div class="totals-row grand">
        <dt>Total</dt>
        <dd class="totals-total">{money(totals.totalMinor)}</dd>
      </div>
    </dl>

    {#if warning}
      <p class="totals-warning">{warning}</p>
    {/if}
  </section>
{/if}

<style>
  .totals-strip {
    margin: 0.75rem 0 0;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  .totals-rows {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }

  .totals-row {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .totals-row dt {
    color: var(--text-muted);
  }

  .totals-row dd {
    margin: 0;
  }

  .totals-row.grand {
    margin-top: 0.25rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--line);
    font-weight: 600;
  }

  .totals-row.grand dt {
    color: var(--text);
  }

  .totals-warning {
    margin: 0.6rem 0 0;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--amber);
    border-radius: 6px;
    color: var(--amber);
    font-size: 0.8rem;
  }
</style>
