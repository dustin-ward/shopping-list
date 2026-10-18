<script lang="ts">
  import {
    receiptLineView,
    suggestionIsBound,
    suggestionTierBadge,
  } from '../../client/receipt-display';
  import {
    lineEditPatch,
    type LineEditFields,
  } from '../../client/receipt-review';
  import type { CatalogItemOption } from '../../client/receipt-binding';
  import { formatMoney, moneyInputValue } from '../../client/money';
  import ReceiptItemPicker from './ReceiptItemPicker.svelte';
  import {
    REVIEW_STATE_LABELS,
    nextReviewState,
    type ReviewStateAction,
  } from '../../shared/receipt-review';
  import type {
    ReceiptDetailLine,
    ReceiptLinePatch,
    ReceiptSuggestion,
  } from '../../shared/schemas';

  // Every parsed row is rendered, parked ones included: no-loss is a promise the
  // reviewer has to be able to see, not a database detail. Suggestions come from
  // the detail payload (tier 1 = the binding the line sits on, tier 2 = chips
  // that are shown but never applied) and are tappable: a chip binds the line
  // with the accepted rank, and the chip the line already sits on releases it.
  //
  // In `editable` mode an item row is its own small form: the printed text,
  // quantity, unit and prices are the reviewer's to correct, the two state
  // controls are the paths a reviewer can take without choosing an item, and the
  // item picker searches the household's items or drafts a new one inline.
  // Parked rows stay parser-settled and read-only.
  let {
    lines,
    currency = null,
    editable = false,
    saving = false,
    catalogItems = [],
    drafts = {},
    onLineEdit,
    onSuggestion,
    onBindItem,
    onDraftItem,
    onDraftName,
    onRelease,
  }: {
    lines: readonly ReceiptDetailLine[];
    currency?: string | null;
    editable?: boolean;
    saving?: boolean;
    catalogItems?: readonly CatalogItemOption[];
    /** Inline-created item names, by line id; empty until a reviewer drafts one. */
    drafts?: Readonly<Record<string, string>>;
    onLineEdit?: (lineId: string, patch: ReceiptLinePatch) => void;
    onSuggestion?: (
      line: ReceiptDetailLine,
      suggestion: ReceiptSuggestion,
    ) => void;
    onBindItem?: (lineId: string, catalogItemId: string) => void;
    onDraftItem?: (lineId: string) => void;
    onDraftName?: (lineId: string, name: string) => void;
    onRelease?: (lineId: string) => void;
  } = $props();

  const UNITS = ['lb', 'kg', 'oz', 'g', 'l', 'ml', 'ea'] as const;

  /** Form problems stay with the row that has them. */
  let errors = $state<Record<string, string>>({});

  function readForm(form: HTMLFormElement): LineEditFields {
    const data = new FormData(form);
    const value = (name: string): string => {
      const entry = data.get(name);
      return typeof entry === 'string' ? entry : '';
    };
    return {
      rawText: value('rawText'),
      quantityReal: value('quantityReal'),
      quantityText: value('quantityText'),
      quantityUnit: value('quantityUnit'),
      unitPriceMinor: value('unitPriceMinor'),
      totalPriceMinor: value('totalPriceMinor'),
    };
  }

  /**
   * Send whatever the row's form now holds. A form that matches the stored line
   * sends nothing, which is what keeps a blur and the Enter key from saving the
   * same edit twice.
   */
  function submitLine(line: ReceiptDetailLine, form: HTMLFormElement): void {
    const result = lineEditPatch(readForm(form), line);
    if (!result.ok) {
      errors = { ...errors, [line.id]: result.message };
      return;
    }
    const { [line.id]: _fixed, ...rest } = errors;
    errors = rest;
    if (result.patch) onLineEdit?.(line.id, result.patch);
  }

  /** The two states a reviewer reaches without picking an item. */
  function setState(line: ReceiptDetailLine, action: ReviewStateAction): void {
    onLineEdit?.(line.id, {
      reviewState: nextReviewState(line.reviewState, action),
    });
  }

  function quantityValue(quantity: number | null): string {
    return quantity === null ? '' : String(quantity);
  }

  function isFormControl(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLInputElement || target instanceof HTMLSelectElement
    );
  }
</script>

{#if lines.length}
  <ul class="receipt-lines">
    {#each lines as line (line.id)}
      {@const view = receiptLineView(line)}
      {@const suggestions = line.suggestions ?? []}
      {@const editableLine = editable && line.isItemChunk}
      <li
        class="receipt-line"
        class:parked={view.parked}
        class:editing={editableLine}
      >
        {#if editableLine}
          <form
            class="line-editor"
            aria-label={`Line ${line.lineIndex + 1}`}
            onsubmit={(event) => {
              event.preventDefault();
              submitLine(line, event.currentTarget);
            }}
            onchange={(event) => {
              if (isFormControl(event.target)) {
                submitLine(line, event.currentTarget);
              }
            }}
          >
            <div class="line-text">
              <input
                class="line-printed"
                name="rawText"
                aria-label="Printed text"
                value={line.rawText}
              />
              <span class="line-state state-{line.reviewState}"
                >{REVIEW_STATE_LABELS[line.reviewState]}</span
              >
              {#if view.parsedName}
                <span class="line-parsed-name">{view.parsedName}</span>
              {/if}
            </div>

            <div class="line-fields">
              <label class="line-field">
                <span class="line-field-label">Qty</span>
                <input
                  class="line-quantity"
                  name="quantityReal"
                  inputmode="decimal"
                  aria-label="Quantity"
                  value={quantityValue(line.quantityReal)}
                />
              </label>
              <label class="line-field">
                <span class="line-field-label">Unit</span>
                <select
                  class="line-unit"
                  name="quantityUnit"
                  aria-label="Unit"
                  value={line.quantityUnit ?? ''}
                >
                  <option value="">—</option>
                  {#each UNITS as unit (unit)}
                    <option value={unit}>{unit}</option>
                  {/each}
                </select>
              </label>
              <label class="line-field">
                <span class="line-field-label">Printed qty</span>
                <input
                  class="line-quantity-text"
                  name="quantityText"
                  aria-label="Printed quantity"
                  value={line.quantityText ?? ''}
                />
              </label>
              <label class="line-field">
                <span class="line-field-label">Unit price</span>
                <input
                  class="line-unit-price"
                  name="unitPriceMinor"
                  inputmode="decimal"
                  aria-label="Unit price"
                  value={moneyInputValue(line.unitPriceMinor)}
                />
              </label>
              <label class="line-field">
                <span class="line-field-label">Line total</span>
                <input
                  class="line-total-price"
                  name="totalPriceMinor"
                  inputmode="decimal"
                  aria-label="Line total"
                  value={moneyInputValue(line.totalPriceMinor)}
                />
              </label>
            </div>

            <div class="line-actions" role="group" aria-label="Review state">
              <button
                type="button"
                class="state-button"
                class:active={line.reviewState === 'unknown'}
                aria-pressed={line.reviewState === 'unknown'}
                disabled={saving}
                onclick={() => setState(line, 'unknown')}
              >
                Can't identify
              </button>
              <button
                type="button"
                class="state-button"
                class:active={line.reviewState === 'skipped'}
                aria-pressed={line.reviewState === 'skipped'}
                disabled={saving}
                onclick={() => setState(line, 'skipped')}
              >
                Skip
              </button>
            </div>

            {#if errors[line.id]}
              <p class="line-error" role="alert">{errors[line.id]}</p>
            {/if}
          </form>

          <ReceiptItemPicker
            {line}
            {catalogItems}
            draftName={drafts[line.id] ?? ''}
            disabled={saving}
            onBind={(catalogItemId) => onBindItem?.(line.id, catalogItemId)}
            onDraft={() => onDraftItem?.(line.id)}
            onDraftName={(name) => onDraftName?.(line.id, name)}
            onRelease={() => onRelease?.(line.id)}
          />
        {:else}
          <div class="line-text">
            <span class="line-printed">{view.printedText}</span>
            {#if !view.parked}
              <span class="line-state state-{line.reviewState}"
                >{REVIEW_STATE_LABELS[line.reviewState]}</span
              >
            {/if}
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
        {/if}
        {#if suggestions.length}
          <ul class="line-suggestions" aria-label="Suggested items">
            {#each suggestions as suggestion (suggestion.catalogItemId)}
              {@const tier = suggestionTierBadge(suggestion.tier)}
              {@const bound = suggestionIsBound(line, suggestion)}
              <li class="suggestion-chip" class:bound>
                <button
                  type="button"
                  class="suggestion-button"
                  title={bound ? `Release ${suggestion.name}` : tier.hint}
                  disabled={!editable || saving}
                  onclick={() => onSuggestion?.(line, suggestion)}
                >
                  <span class="suggestion-name">{suggestion.name}</span>
                  <span class="suggestion-tier">{tier.label}</span>
                  {#if bound}
                    <span class="suggestion-bound">Bound</span>
                  {/if}
                </button>
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

  /* An item row the reviewer can correct, so it reads as a form. */
  .receipt-line.editing {
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
  }

  .line-editor {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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

  input.line-printed {
    width: 100%;
    border: 1px solid transparent;
    border-bottom-color: var(--line);
    border-radius: 2px;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
  }

  .line-parsed-name {
    color: var(--text-muted);
    font-size: 0.82rem;
  }

  .line-state {
    align-self: flex-start;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .line-state.state-unknown {
    border-color: var(--amber);
    color: var(--amber);
  }

  .line-state.state-bound,
  .line-state.state-new {
    border-color: var(--success);
    color: var(--success);
  }

  .line-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .line-field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 4.25rem;
  }

  .line-field-label {
    color: var(--text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .line-field input,
  .line-field select {
    padding: 0.25rem 0.35rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-inset);
    color: inherit;
    font: inherit;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }

  .line-actions {
    display: flex;
    gap: 0.4rem;
  }

  .state-button {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-inset);
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .state-button.active {
    border-color: var(--amber);
    background: var(--accent-soft);
    color: var(--text);
  }

  .state-button:disabled {
    opacity: 0.6;
  }

  .line-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.78rem;
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
  }

  /* One tappable candidate: accepting it binds the line, accepting the bound
     one again releases it. */
  .suggestion-button {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-inset);
    color: inherit;
    font-size: 0.75rem;
  }

  .suggestion-button:disabled {
    opacity: 0.7;
  }

  /* The binding the line already sits on, so an auto-bind is never invisible. */
  .suggestion-chip.bound .suggestion-button {
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
