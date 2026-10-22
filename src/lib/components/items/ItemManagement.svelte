<script lang="ts">
  import {
    itemCountSummary,
    mergeAliasSentence,
    mergeAuditRows,
    mergeConsequences,
    mergeQuestion,
    mergeReportSentence,
    type MergeDraft,
    type RenameDraft,
  } from '../../client/item-management';
  import type { ItemSummary, MergeItemsResult } from '../../shared/schemas';

  // The canonical-item admin surface as the household meets it (ticket 19): a
  // rename of the household term, and a merge that moves one item's whole
  // history into another and then shows the before/after counts that prove
  // nothing was left behind. Both are deliberate acts — the merge asks twice —
  // and neither rewrites printed evidence or alias wording.
  //
  // The container owns the requests and the state; this component only renders
  // what it is handed, which is what lets the surface be exercised without a
  // browser.
  let {
    items,
    writable = false,
    busy = false,
    error = '',
    notice = '',
    renameDraft = null,
    mergeDraft = null,
    report = null,
    onRenameStart,
    onRenameName,
    onRenameSubmit,
    onRenameCancel,
    onMergeStart,
    onMergeSurvivor,
    onMergeReview,
    onMergeConfirm,
    onMergeCancel,
    onReportDismiss,
  }: {
    items: readonly ItemSummary[];
    writable?: boolean;
    busy?: boolean;
    error?: string;
    notice?: string;
    /** The item whose name is being edited, if any. */
    renameDraft?: RenameDraft | null;
    /** The merge being prepared, if any. */
    mergeDraft?: MergeDraft | null;
    /** The audit report of the merge that just finished, if any. */
    report?: MergeItemsResult | null;
    onRenameStart: (item: ItemSummary) => void;
    onRenameName: (name: string) => void;
    onRenameSubmit: () => void;
    onRenameCancel: () => void;
    onMergeStart: (item: ItemSummary) => void;
    onMergeSurvivor: (survivorId: string) => void;
    onMergeReview: () => void;
    onMergeConfirm: () => void;
    onMergeCancel: () => void;
    onReportDismiss: () => void;
  } = $props();

  const absorbed = $derived(
    items.find((item) => item.id === mergeDraft?.absorbedId) ?? null,
  );
  const survivor = $derived(
    items.find((item) => item.id === mergeDraft?.survivorId) ?? null,
  );
  const candidates = $derived(
    items.filter((item) => item.id !== mergeDraft?.absorbedId),
  );
  const auditRows = $derived(report ? mergeAuditRows(report) : []);
</script>

<section class="item-management" aria-label="Item management">
  <p class="item-intro">
    An item is the household's own term for a product. Renaming changes that
    term; it never rewrites what a receipt printed or what an alias answers to.
    Merging moves one item's receipts, purchases, list entries and aliases onto
    another and removes the absorbed item.
  </p>

  {#if error}
    <p class="message error-message" role="alert">{error}</p>
  {/if}
  {#if notice}
    <p class="item-notice" role="status">{notice}</p>
  {/if}

  {#if report}
    <section class="merge-report" aria-label="Merge report">
      <h3>Merged "{report.absorbed.name}" into "{report.survivor.name}"</h3>
      <p>{mergeReportSentence(report)}</p>
      <div class="audit-scroll">
        <table class="audit-table">
          <caption>Reference counts: before and after</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">"{report.absorbed.name}" before</th>
              <th scope="col">"{report.absorbed.name}" after</th>
              <th scope="col">"{report.survivor.name}" before</th>
              <th scope="col">"{report.survivor.name}" after</th>
            </tr>
          </thead>
          <tbody>
            {#each auditRows as row (row.label)}
              <tr>
                <th scope="row">
                  {row.label}
                  {#if row.note}<span class="audit-note">{row.note}</span>{/if}
                </th>
                <td>{row.absorbedBefore}</td>
                <td>{row.absorbedAfter}</td>
                <td>{row.survivorBefore}</td>
                <td>{row.survivorAfter}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p>{mergeAliasSentence(report)}</p>
      <button type="button" class="quiet-button" onclick={onReportDismiss}>
        Dismiss report
      </button>
    </section>
  {/if}

  {#if items.length === 0}
    <p class="empty-list">
      No items yet. Items appear here once something is added to the list or a
      receipt names one.
    </p>
  {:else}
    <ul class="item-list">
      {#each items as item (item.id)}
        <li class="item-card">
          <div class="item-row">
            <div class="item-copy">
              <h3>{item.name}</h3>
              <p class="item-counts">{itemCountSummary(item.counts)}</p>
            </div>
            {#if writable}
              <div class="item-actions">
                <button
                  type="button"
                  class="quiet-button"
                  aria-label={`Rename ${item.name}`}
                  disabled={busy}
                  onclick={() => onRenameStart(item)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  class="quiet-button"
                  aria-label={`Merge ${item.name} into…`}
                  disabled={busy || items.length < 2}
                  onclick={() => onMergeStart(item)}
                >
                  Merge into…
                </button>
              </div>
            {/if}
          </div>

          {#if renameDraft?.itemId === item.id}
            <form
              class="rename-form"
              onsubmit={(event) => {
                event.preventDefault();
                onRenameSubmit();
              }}
            >
              <label class="field">
                <span>New household term</span>
                <input
                  value={renameDraft.name}
                  maxlength="120"
                  autocomplete="off"
                  disabled={busy}
                  oninput={(event) => onRenameName(event.currentTarget.value)}
                />
              </label>
              <div class="form-actions">
                <button
                  type="submit"
                  class="primary-button"
                  disabled={busy || !renameDraft.name.trim()}
                >
                  {busy ? 'Saving…' : 'Save name'}
                </button>
                <button
                  type="button"
                  class="quiet-button"
                  disabled={busy}
                  onclick={onRenameCancel}
                >
                  Cancel
                </button>
              </div>
              <p class="item-hint">
                Printed receipt text, purchase snapshots and aliases keep their
                own wording. Visible list entries adopt the new term.
              </p>
            </form>
          {/if}

          {#if mergeDraft?.absorbedId === item.id}
            <div class="merge-panel" aria-label={`Merge ${item.name}`}>
              {#if !mergeDraft.confirming}
                <label class="field">
                  <span>Merge "{item.name}" into</span>
                  <select
                    value={mergeDraft.survivorId ?? ''}
                    disabled={busy}
                    onchange={(event) =>
                      onMergeSurvivor(event.currentTarget.value)}
                  >
                    <option value="">Choose an item…</option>
                    {#each candidates as candidate (candidate.id)}
                      <option value={candidate.id}>{candidate.name}</option>
                    {/each}
                  </select>
                </label>
                <div class="form-actions">
                  <button
                    type="button"
                    class="primary-button"
                    disabled={busy || !mergeDraft.survivorId}
                    onclick={onMergeReview}
                  >
                    Review merge
                  </button>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busy}
                    onclick={onMergeCancel}
                  >
                    Cancel
                  </button>
                </div>
              {:else if survivor}
                <p class="merge-question">
                  {mergeQuestion(item, survivor)}
                </p>
                <p class="merge-consequences">
                  {mergeConsequences(item, survivor)}
                </p>
                <div class="form-actions">
                  <button
                    type="button"
                    class="primary-button danger-button"
                    disabled={busy}
                    onclick={onMergeConfirm}
                  >
                    {busy
                      ? 'Merging…'
                      : `Merge ${item.name} into ${survivor.name}`}
                  </button>
                  <button
                    type="button"
                    class="quiet-button"
                    disabled={busy}
                    onclick={onMergeCancel}
                  >
                    Cancel
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .item-management {
    display: grid;
    gap: 0.9rem;
  }

  .item-intro,
  .item-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .item-notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border: 1px solid #59684a;
    border-radius: 2px;
    color: var(--success);
    background: #252b21;
    font-size: 0.85rem;
  }

  .item-list {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item-card {
    display: grid;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
  }

  .item-row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }

  .item-copy {
    display: grid;
    flex: 1;
    gap: 0.2rem;
  }

  .item-copy h3 {
    margin: 0;
    font-size: 1rem;
  }

  .item-counts {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .item-actions {
    display: flex;
    flex: none;
    gap: 0.4rem;
  }

  .rename-form,
  .merge-panel {
    display: grid;
    gap: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--line);
  }

  .field {
    display: grid;
    gap: 0.3rem;
    font-size: 0.85rem;
  }

  .field input,
  .field select {
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface-inset);
    color: var(--text);
    font: inherit;
  }

  .form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .merge-question {
    margin: 0;
    font-family: var(--font-display);
    font-size: 0.95rem;
  }

  .merge-consequences {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .danger-button {
    border-color: #81564b;
    background: #81564b;
  }

  .merge-report {
    display: grid;
    gap: 0.6rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--line-bright);
    border-radius: 12px;
    background: var(--surface-inset);
  }

  .merge-report h3,
  .merge-report p {
    margin: 0;
  }

  .audit-scroll {
    overflow-x: auto;
  }

  .audit-table {
    width: 100%;
    min-width: 34rem;
    border-collapse: collapse;
    font-size: 0.8rem;
  }

  .audit-table caption {
    padding-bottom: 0.35rem;
    color: var(--text-muted);
    text-align: left;
  }

  .audit-table th,
  .audit-table td {
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid var(--line);
    text-align: right;
    vertical-align: top;
  }

  .audit-table thead th {
    color: var(--text-muted);
    font-weight: 500;
  }

  .audit-table th:first-child,
  .audit-table td:first-child {
    text-align: left;
  }

  .audit-note {
    display: block;
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.72rem;
  }
</style>
