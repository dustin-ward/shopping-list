<script lang="ts">
  import { formatMoney } from '../../client/money';
  import {
    filterItems,
    type CatalogItemOption,
  } from '../../client/receipt-binding';
  import {
    unidentifiedSpendSummary,
    unknownBindQuestion,
    unknownGroupLabel,
    unknownLineCountLabel,
  } from '../../client/receipt-unknowns';
  import type {
    UnknownLineGroup,
    UnknownLinesOverview,
  } from '../../shared/schemas';

  // The recategorization surface for unknown lines (ticket 17; plan §13): the
  // wordings committed receipts printed that nobody could identify, grouped by
  // their normalized text, with the line count and money each one holds. The
  // same rows are the unidentified-spending view, so the total sits above the
  // groups rather than on a dashboard of its own.
  //
  // Binding is a two-tap act, like every deliberate write in this feature: the
  // first tap chooses the item, the second confirms — because one tap moves
  // every constituent line across every receipt that printed the wording, and
  // learns the alias that will bind it next time. The container owns the
  // requests and the pending choice; this component renders what it is handed,
  // so the surface can be exercised without a browser.
  let {
    overview,
    catalogItems = [],
    writable = false,
    pending = {},
    busyGroup = null,
    error = '',
    notice = '',
    onBind,
    onSelect,
    onCancel,
  }: {
    overview: UnknownLinesOverview;
    catalogItems?: readonly CatalogItemOption[];
    writable?: boolean;
    /** The item chosen for a group, by normalized text; `{}` while none is. */
    pending?: Readonly<Record<string, string>>;
    /** The group whose bind is in flight, if any. */
    busyGroup?: string | null;
    error?: string;
    notice?: string;
    onBind: (group: UnknownLineGroup, catalogItemId: string) => void;
    onSelect: (group: UnknownLineGroup, catalogItemId: string) => void;
    onCancel: (group: UnknownLineGroup) => void;
  } = $props();

  /** What the reviewer typed for each group; empty until they search. */
  let searches = $state<Record<string, string>>({});

  function itemName(catalogItemId: string): string {
    return (
      catalogItems.find((item) => item.id === catalogItemId)?.name ??
      'this item'
    );
  }

  function matches(group: UnknownLineGroup): CatalogItemOption[] {
    return filterItems(catalogItems, searches[group.normalizedText] ?? '');
  }

  function searchTerm(group: UnknownLineGroup): string {
    return searches[group.normalizedText] ?? '';
  }

  function updateSearch(group: UnknownLineGroup, value: string): void {
    searches = { ...searches, [group.normalizedText]: value };
  }

  function chosenItem(group: UnknownLineGroup): string | null {
    return pending[group.normalizedText] ?? null;
  }
</script>

<section class="unknown-browser" aria-label="Unknown lines">
  <p class="unknown-intro">
    Wordings nobody could identify, grouped across committed receipts. Each
    group is the unidentified spending for that wording; binding it moves every
    line at once and teaches matching the wording for next time.
  </p>

  <p class="unknown-total" role="status">
    {unidentifiedSpendSummary(overview)}
  </p>

  {#if error}
    <p class="message error-message" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="unknown-notice" role="status">{notice}</p>
  {/if}

  {#if overview.groups.length}
    <ul class="unknown-groups">
      {#each overview.groups as group (group.normalizedText)}
        {@const chosenItemId = chosenItem(group)}
        {@const label = unknownGroupLabel(group)}
        <li class="unknown-group">
          <div class="unknown-group-head">
            <span class="unknown-text">{label}</span>
            <span class="unknown-count"
              >{unknownLineCountLabel(group.lineCount)}</span
            >
            {#if group.receiptCount > 1}
              <span class="unknown-receipts"
                >across {group.receiptCount} receipts</span
              >
            {/if}
            <span class="unknown-spend"
              >{formatMoney(group.spendMinor, overview.currency)}</span
            >
          </div>

          {#if writable}
            <div class="unknown-bind">
              {#if chosenItemId}
                <p class="unknown-question">
                  {unknownBindQuestion(group, itemName(chosenItemId))}
                </p>
                <div class="unknown-actions">
                  <button
                    type="button"
                    class="unknown-confirm"
                    disabled={busyGroup === group.normalizedText}
                    onclick={() => onBind(group, chosenItemId)}
                  >
                    Bind {unknownLineCountLabel(group.lineCount)}
                  </button>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busyGroup === group.normalizedText}
                    onclick={() => onCancel(group)}
                  >
                    Cancel
                  </button>
                </div>
              {:else}
                <label class="unknown-search">
                  <span class="unknown-search-label">Find item</span>
                  <input
                    aria-label={`Find item for ${label}`}
                    placeholder="Search items…"
                    value={searchTerm(group)}
                    oninput={(event) =>
                      updateSearch(group, event.currentTarget.value)}
                  />
                </label>
                {#if searchTerm(group).trim()}
                  <div class="unknown-matches">
                    {#each matches(group) as item (item.id)}
                      <button
                        type="button"
                        class="unknown-match"
                        disabled={busyGroup === group.normalizedText}
                        onclick={() => onSelect(group, item.id)}
                      >
                        {item.name}
                      </button>
                    {/each}
                    {#if matches(group).length === 0}
                      <span class="unknown-no-match">No item matches.</span>
                    {/if}
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .unknown-browser {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .unknown-intro {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .unknown-total {
    margin: 0;
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface-inset);
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }

  .unknown-notice {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid #59684a;
    border-radius: 2px;
    color: var(--success);
    background: #252b21;
    font-size: 0.85rem;
  }

  .unknown-groups {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .unknown-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  .unknown-group-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }

  .unknown-text {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .unknown-count,
  .unknown-receipts {
    color: var(--text-muted);
    font-size: 0.78rem;
  }

  .unknown-spend {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .unknown-bind {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .unknown-search {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .unknown-search-label {
    color: var(--text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .unknown-search input {
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-inset);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
  }

  .unknown-matches,
  .unknown-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .unknown-match,
  .unknown-confirm {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line-bright);
    border-radius: 999px;
    background: var(--surface-inset);
    color: var(--text);
    font-size: 0.78rem;
  }

  .unknown-confirm {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--page-bg);
    font-weight: 600;
  }

  .unknown-match:disabled,
  .unknown-confirm:disabled {
    opacity: 0.6;
  }

  .unknown-question {
    margin: 0;
    font-size: 0.82rem;
  }

  .unknown-no-match {
    color: var(--text-muted);
    font-size: 0.78rem;
  }
</style>
