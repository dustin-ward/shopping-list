<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchItemOverview,
    mergeErrorMessage,
    renameErrorMessage,
    submitItemMerge,
    submitItemRename,
    type MergeDraft,
    type RenameDraft,
  } from '../../client/item-management';
  import ItemManagement from './ItemManagement.svelte';
  import type { ItemSummary, MergeItemsResult } from '../../shared/schemas';

  // The item-management container: it owns the read, the two drafts and their
  // requests, while the presenter stays a renderer. Both writes are
  // snapshot-visible, so every success hands the new revision to the page,
  // which requires it and refreshes the shared snapshot.
  let {
    writable = false,
    serverInstanceId = '',
    onChanged = () => {},
  }: {
    writable?: boolean;
    serverInstanceId?: string;
    onChanged?: (result: {
      serverInstanceId: string;
      revision: number;
    }) => void | Promise<void>;
  } = $props();

  let items = $state<ItemSummary[]>([]);
  let loading = $state(true);
  let loaded = $state(false);
  let loadError = $state('');
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let renameDraft = $state<RenameDraft | null>(null);
  let mergeDraft = $state<MergeDraft | null>(null);
  let report = $state<MergeItemsResult | null>(null);

  onMount(() => {
    void loadItems();
  });

  async function loadItems(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      items = (await fetchItemOverview()).items;
      loaded = true;
    } catch {
      loadError = 'Items are unavailable. Refresh and try again.';
    } finally {
      loading = false;
    }
  }

  function startRename(item: ItemSummary): void {
    renameDraft = { itemId: item.id, name: item.name };
    mergeDraft = null;
    error = '';
    notice = '';
  }

  function cancelRename(): void {
    renameDraft = null;
    error = '';
  }

  async function submitRename(): Promise<void> {
    const draft = renameDraft;
    const item = items.find((candidate) => candidate.id === draft?.itemId);
    if (!draft || !item) return;
    busy = true;
    error = '';
    notice = '';
    try {
      const result = await submitItemRename(
        item.id,
        serverInstanceId,
        item.name,
        draft.name,
      );
      renameDraft = null;
      notice = `Renamed "${item.name}" to "${result.item.name}".`;
      await afterWrite(result);
    } catch (failure) {
      error = renameErrorMessage(failure);
      // A stale or vanished item means this screen's copy cannot be acted on
      // again; fetch the truth and let the reviewer start over.
      renameDraft = null;
      await loadItems();
    } finally {
      busy = false;
    }
  }

  function startMerge(item: ItemSummary): void {
    mergeDraft = { absorbedId: item.id, survivorId: null, confirming: false };
    renameDraft = null;
    error = '';
    notice = '';
  }

  function chooseSurvivor(survivorId: string): void {
    if (!mergeDraft) return;
    mergeDraft = { ...mergeDraft, survivorId: survivorId || null };
  }

  function reviewMerge(): void {
    if (!mergeDraft?.survivorId) return;
    mergeDraft = { ...mergeDraft, confirming: true };
  }

  function cancelMerge(): void {
    mergeDraft = null;
    error = '';
  }

  async function confirmMerge(): Promise<void> {
    const draft = mergeDraft;
    if (!draft?.survivorId) return;
    const absorbed = items.find((item) => item.id === draft.absorbedId);
    const survivor = items.find((item) => item.id === draft.survivorId);
    if (!absorbed || !survivor) return;

    busy = true;
    error = '';
    notice = '';
    try {
      const result = await submitItemMerge(
        absorbed,
        survivor,
        serverInstanceId,
      );
      mergeDraft = null;
      report = result;
      await afterWrite(result);
    } catch (failure) {
      error = mergeErrorMessage(failure);
      mergeDraft = null;
      // The conflict may be a stale name or an entry another device added;
      // either way the loaded counts are the ones the next attempt must use.
      await loadItems();
    } finally {
      busy = false;
    }
  }

  function dismissReport(): void {
    report = null;
  }

  async function afterWrite(result: {
    serverInstanceId: string;
    revision: number;
  }): Promise<void> {
    await onChanged(result);
    await loadItems();
  }
</script>

<section class="secondary-screen items-screen" aria-labelledby="items-heading">
  <div class="list-heading">
    <div>
      <p class="eyebrow">Household terms</p>
      <h2 id="items-heading">Items</h2>
    </div>
  </div>

  {#if loadError}
    <p class="message error-message" role="alert">{loadError}</p>
  {/if}

  {#if loading && !loaded}
    <p class="empty-list">Loading items…</p>
  {:else}
    <ItemManagement
      {items}
      {writable}
      {busy}
      {error}
      {notice}
      {renameDraft}
      {mergeDraft}
      {report}
      onRenameStart={startRename}
      onRenameName={(name) => {
        if (renameDraft) renameDraft = { ...renameDraft, name };
      }}
      onRenameSubmit={() => void submitRename()}
      onRenameCancel={cancelRename}
      onMergeStart={startMerge}
      onMergeSurvivor={chooseSurvivor}
      onMergeReview={reviewMerge}
      onMergeConfirm={() => void confirmMerge()}
      onMergeCancel={cancelMerge}
      onReportDismiss={dismissReport}
    />
  {/if}
</section>
