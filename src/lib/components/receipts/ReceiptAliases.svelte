<script lang="ts">
  import {
    aliasSourceLabel,
    ambiguitySentence,
    deletedAliasCount,
    visibleAliases,
  } from '../../client/receipt-aliases';
  import type { AliasOverview } from '../../shared/schemas';

  // The alias lifecycle as the reviewer meets it (plan §7): every learned alias
  // under the item it answers to, a two-tap delete for the wrong one (the same
  // deliberate confirm the discard path uses), and the phrases two items claim
  // — listed because matching asked about them instead of guessing, never
  // because anything was resolved silently.
  //
  // The container owns the requests and the state; this component only renders
  // what it is handed, which is what lets the whole surface be exercised without
  // a browser.
  let {
    overview,
    writable = false,
    includeDeleted = false,
    pendingDeleteId = null,
    busyAliasId = null,
    error = '',
    notice = '',
    onToggleDeleted,
    onRequestDelete,
    onCancelDelete,
    onConfirmDelete,
  }: {
    overview: AliasOverview;
    writable?: boolean;
    includeDeleted?: boolean;
    /** The alias whose delete is being confirmed, if any. */
    pendingDeleteId?: string | null;
    /** The alias whose delete is in flight, if any. */
    busyAliasId?: string | null;
    error?: string;
    notice?: string;
    onToggleDeleted: () => void;
    onRequestDelete: (aliasId: string) => void;
    onCancelDelete: () => void;
    onConfirmDelete: (aliasId: string) => void;
  } = $props();

  /** One item's rows, with the deleted ones dropped unless the audit view is on. */
  const shownItems = $derived(
    overview.items
      .map((item) => ({ item, aliases: visibleAliases(item, includeDeleted) }))
      .filter((entry) => entry.aliases.length > 0),
  );
  const deletedCount = $derived(deletedAliasCount(overview));

  function learnedOn(value: string): string {
    return new Date(value).toLocaleDateString([], { dateStyle: 'medium' });
  }
</script>

<section class="alias-manager" aria-label="Learned aliases">
  <p class="alias-intro">
    An alias is the printed wording an item answers to. Matching binds it
    automatically on later receipts; deleting one stops that at once, while the
    row stays for audit until the same text is confirmed again.
  </p>

  {#if error}
    <p class="message error-message" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="alias-notice" role="status">{notice}</p>
  {/if}

  {#if overview.ambiguous.length}
    <section class="ambiguity-panel" aria-label="Ambiguous phrases">
      <h3>Matching asks about these phrases</h3>
      <ul class="ambiguity-list">
        {#each overview.ambiguous as phrase (phrase.normalizedPhrase)}
          <li class="ambiguity-row">{ambiguitySentence(phrase)}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if deletedCount > 0}
    <button
      type="button"
      class="quiet-button deleted-toggle"
      aria-pressed={includeDeleted}
      onclick={onToggleDeleted}
    >
      {includeDeleted
        ? 'Hide deleted aliases'
        : `Show deleted aliases (${deletedCount})`}
    </button>
  {/if}

  {#if shownItems.length}
    {#each shownItems as { item, aliases } (item.catalogItemId)}
      <section class="alias-item" aria-label={`Aliases for ${item.name}`}>
        <h3>{item.name}</h3>
        <ul class="alias-list">
          {#each aliases as alias (alias.id)}
            <li class="alias-row" class:deleted={Boolean(alias.deletedAt)}>
              <span class="alias-text">{alias.aliasText}</span>
              <span class="alias-source">{aliasSourceLabel(alias.source)}</span>
              {#if alias.deletedAt}
                <span class="alias-dates"
                  >Deleted {learnedOn(alias.deletedAt)}</span
                >
                <span class="alias-deleted">Kept for audit</span>
              {:else}
                <span class="alias-dates"
                  >Learned {learnedOn(alias.createdAt)}</span
                >
                {#if writable}
                  {#if pendingDeleteId === alias.id}
                    <span class="alias-confirm">
                      <span class="alias-confirm-note"
                        >Deleting stops auto-binding; the row is kept for audit.</span
                      >
                      <button
                        type="button"
                        class="quiet-button danger-text"
                        disabled={busyAliasId === alias.id}
                        onclick={() => onConfirmDelete(alias.id)}
                      >
                        {busyAliasId === alias.id
                          ? 'Deleting…'
                          : 'Delete alias'}
                      </button>
                      <button
                        type="button"
                        class="quiet-button"
                        disabled={busyAliasId === alias.id}
                        onclick={onCancelDelete}
                      >
                        Cancel
                      </button>
                    </span>
                  {:else}
                    <button
                      type="button"
                      class="quiet-button danger-text alias-delete"
                      aria-label={`Delete alias ${alias.aliasText}`}
                      onclick={() => onRequestDelete(alias.id)}
                    >
                      Delete
                    </button>
                  {/if}
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {:else}
    <p class="empty-list">
      No aliases to show. Committing a reviewed receipt teaches the printed text
      its line was bound to, and the next receipt with that wording binds by
      itself.
    </p>
  {/if}
</section>

<style>
  .alias-manager {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .alias-intro {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .alias-notice {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border: 1px solid #59684a;
    border-radius: 2px;
    color: var(--success);
    background: #252b21;
    font-size: 0.85rem;
  }

  .ambiguity-panel {
    padding: 0.75rem 0.85rem;
    border: 1px solid var(--amber);
    border-radius: 8px;
    background: var(--surface-inset);
  }

  .ambiguity-panel h3 {
    margin: 0 0 0.4rem;
    color: var(--amber);
    font-size: 0.9rem;
  }

  .ambiguity-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.82rem;
  }

  .deleted-toggle {
    align-self: flex-start;
  }

  .alias-item {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
  }

  .alias-item h3 {
    margin: 0;
    font-size: 0.95rem;
  }

  .alias-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .alias-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.82rem;
  }

  /* A soft-deleted row is retained information, not an active mapping. */
  .alias-row.deleted {
    color: var(--text-muted);
  }

  .alias-row.deleted .alias-text {
    text-decoration: line-through;
  }

  .alias-text {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .alias-source,
  .alias-deleted {
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 0.68rem;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .alias-deleted {
    border-color: var(--amber);
    color: var(--amber);
  }

  .alias-dates {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .alias-confirm {
    display: flex;
    flex: 1 0 100%;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }

  .alias-confirm-note {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.78rem;
  }
</style>
