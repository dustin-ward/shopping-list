<script lang="ts">
  import type { GroupOption } from '../../client/receipt-binding';

  // The receipt's store (plan §10): prefilled with the best match, required
  // before commit, and free to be a brand-new store — which stays a draft until
  // commit creates the group. Picking an existing store is an ordinary review
  // edit; the draft is the reviewer's name, kept in the editor.
  const DRAFT_OPTION = '__draft_store__';

  let {
    stores = [],
    storeGroupId = null,
    draftName = '',
    prefill = null,
    editable = false,
    onChoose,
    onDraft,
    onClearDraft,
  }: {
    /** The household's store groups — a store *is* a group of `kind: 'store'`. */
    stores?: readonly GroupOption[];
    storeGroupId?: string | null;
    draftName?: string;
    prefill?: GroupOption | null;
    editable?: boolean;
    onChoose: (storeGroupId: string | null) => void;
    onDraft: (name: string) => void;
    onClearDraft: () => void;
  } = $props();

  let creating = $state(false);
  let newName = $state('');

  const chosenName = $derived(
    stores.find((store) => store.id === storeGroupId)?.name ?? null,
  );
  const selected = $derived(storeGroupId ?? (draftName ? DRAFT_OPTION : ''));

  function handleSelect(event: Event): void {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === DRAFT_OPTION) return;
    if (value === '') {
      // Clearing the picker undoes whichever choice is standing there.
      if (draftName) onClearDraft();
      else onChoose(null);
      return;
    }
    if (draftName) onClearDraft();
    onChoose(value);
  }

  function confirmDraft(): void {
    const name = newName.trim();
    if (!name) return;
    onDraft(name);
    newName = '';
    creating = false;
  }
</script>

{#if editable}
  <div class="store-controls">
    <select
      class="store-select"
      aria-label="Store"
      aria-required={!storeGroupId && !draftName}
      value={selected}
      onchange={handleSelect}
    >
      <option value=""
        >{storeGroupId || draftName ? 'No store' : 'Choose a store…'}</option
      >
      {#each stores as store (store.id)}
        <option value={store.id}>{store.name}</option>
      {/each}
      {#if draftName}
        <option value={DRAFT_OPTION}>New store: {draftName} (draft)</option>
      {/if}
    </select>

    {#if !storeGroupId && !draftName}
      <p class="store-required" role="status">Store required before commit.</p>
    {/if}

    {#if !storeGroupId && !draftName && prefill}
      <p class="store-prefill">
        Looks like <strong>{prefill.name}</strong>.
        <button
          type="button"
          class="picker-button"
          onclick={() => onChoose(prefill.id)}
        >
          Use {prefill.name}
        </button>
      </p>
    {/if}

    {#if creating}
      <div class="store-draft-form">
        <label class="picker-field">
          <span class="picker-label">New store name</span>
          <input
            class="store-draft-name"
            aria-label="New store name"
            bind:value={newName}
          />
        </label>
        <button
          type="button"
          class="picker-button"
          disabled={!newName.trim()}
          onclick={confirmDraft}
        >
          Use new store
        </button>
        <button
          type="button"
          class="picker-button"
          onclick={() => (creating = false)}
        >
          Cancel
        </button>
      </div>
    {:else if !draftName}
      <button
        type="button"
        class="picker-button create-store-button"
        onclick={() => (creating = true)}
      >
        Create new store
      </button>
    {/if}

    {#if draftName}
      <button
        type="button"
        class="picker-button remove-draft-button"
        onclick={onClearDraft}
      >
        Remove draft store
      </button>
    {/if}
  </div>
{:else}
  <p class="store-readonly">{chosenName ?? 'No store'}</p>
{/if}

<style>
  .store-controls,
  .store-draft-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .store-select {
    min-width: 10rem;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-inset);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
  }

  .store-required,
  .store-prefill,
  .store-readonly {
    margin: 0;
    font-size: 0.8rem;
  }

  .store-required {
    color: var(--amber);
  }

  .store-readonly {
    color: var(--text-muted);
  }

  .picker-field {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 9rem;
  }

  .picker-label {
    color: var(--text-muted);
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .picker-field input {
    padding: 0.25rem 0.35rem;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--surface-inset);
    color: inherit;
    font: inherit;
    font-size: 0.82rem;
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
</style>
