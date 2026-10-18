<script lang="ts">
  import {
    filterItems,
    itemDraftName,
    itemPickerPrefill,
    type CatalogItemOption,
  } from '../../client/receipt-binding';
  import type { ReceiptDetailLine } from '../../shared/schemas';

  // The per-line item picker (plan §10): search the household's items, bind the
  // one the reviewer picks, or draft a new item inline. The search box starts on
  // the line's top candidate — prefigured, never bound until the reviewer taps
  // something. A draft is not a catalog row — it is the reviewer's name, kept in
  // the editor until commit — while the line's `new` state is a review edit like
  // any other.
  let {
    line,
    catalogItems = [],
    draftName = '',
    disabled = false,
    onBind,
    onDraft,
    onDraftName,
    onRelease,
  }: {
    line: ReceiptDetailLine;
    catalogItems?: readonly CatalogItemOption[];
    draftName?: string;
    disabled?: boolean;
    onBind: (catalogItemId: string) => void;
    onDraft: () => void;
    onDraftName: (name: string) => void;
    onRelease: () => void;
  } = $props();

  /**
   * What the reviewer typed, or `null` while they have typed nothing: the box
   * then shows the line's top candidate. Their own words take over the moment
   * they type — and an untouched prefigure never becomes the draft's name, which
   * always starts from the parser's.
   */
  let typed = $state<string | null>(null);

  const searchText = $derived(typed ?? itemPickerPrefill(line));
  const matches = $derived(filterItems(catalogItems, searchText));
  const boundName = $derived(
    catalogItems.find((item) => item.id === line.catalogItemId)?.name ?? null,
  );
  /**
   * A draft always names something: the reviewer's name once they have typed
   * one, the parser's name before that (the plan's "create new item fills
   * `parsed_name`" rule). The draft itself is only this name plus the line's
   * `new` state — no catalog row exists until commit.
   */
  const draftLabel = $derived(draftName || itemDraftName(line));
</script>

{#if line.reviewState === 'bound'}
  <div class="item-binding">
    <span class="binding-item"
      >{boundName ?? line.parsedName ?? 'Bound item'}</span
    >
    <button
      type="button"
      class="picker-button release-button"
      {disabled}
      onclick={onRelease}
    >
      Release
    </button>
  </div>
{:else if line.reviewState === 'new'}
  <div class="item-draft">
    <label class="picker-field">
      <span class="picker-label">New item name</span>
      <input
        class="draft-item-name"
        aria-label="New item name"
        value={draftLabel}
        oninput={(event) => onDraftName(event.currentTarget.value)}
      />
    </label>
    <button
      type="button"
      class="picker-button release-button"
      {disabled}
      onclick={onRelease}
    >
      Remove draft
    </button>
  </div>
{:else}
  <div class="item-search">
    <label class="picker-field">
      <span class="picker-label">Find item</span>
      <input
        class="item-search-input"
        aria-label="Find item"
        placeholder="Search items…"
        value={searchText}
        oninput={(event) => (typed = event.currentTarget.value)}
      />
    </label>
    <div class="item-matches">
      {#each matches as item (item.id)}
        <button
          type="button"
          class="picker-button match-button"
          {disabled}
          onclick={() => onBind(item.id)}
        >
          {item.name}
        </button>
      {/each}
      <button
        type="button"
        class="picker-button draft-button"
        {disabled}
        onclick={() => onDraft()}
      >
        Create new item
      </button>
    </div>
  </div>
{/if}

<style>
  .item-search,
  .item-draft,
  .item-binding {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.4rem;
  }

  .picker-field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 8rem;
    flex: 1;
  }

  .picker-label {
    color: var(--text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .picker-field input {
    width: 100%;
    padding: 0.25rem 0.35rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-inset);
    color: inherit;
    font: inherit;
    font-size: 0.82rem;
  }

  .item-matches {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .picker-button {
    padding: 0.25rem 0.55rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--surface-inset);
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .picker-button:disabled {
    opacity: 0.6;
  }

  .match-button {
    border-color: var(--line-bright);
    color: var(--text);
  }

  .binding-item {
    flex: 1;
    font-size: 0.82rem;
    font-weight: 600;
  }
</style>
