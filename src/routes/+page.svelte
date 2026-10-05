<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ApiError, requestJson } from '../lib/client/api';
  import {
    SnapshotCoordinator,
    type SnapshotClientState,
  } from '../lib/client/snapshot';
  import {
    clearOfflineData,
    loadOfflineSnapshot,
    saveOfflineSnapshot,
  } from '../lib/client/offline';
  import { normalizeName } from '../lib/shared/normalize';
  import {
    DEFAULT_GROUP_COLOR,
    type PurchaseHistoryPage,
    type Snapshot,
  } from '../lib/shared/schemas';

  type Screen = 'list' | 'groups' | 'history';
  const UNGROUPED_SECTION_ID = 'ungrouped';
  type ActiveEntrySection = {
    id: string;
    name: string;
    groupId: string | null;
    color: string;
    entries: Snapshot['entries'];
  };
  const snapshotCoordinator = new SnapshotCoordinator();

  let syncState = $state<SnapshotClientState>(snapshotCoordinator.getState());
  let snapshot = $derived(syncState.snapshot);
  let screen = $state<Screen>('list');
  let menuOpen = $state(false);
  let connectionState = $derived(syncState.status);
  let lastVerifiedAt = $derived(syncState.lastVerifiedAt);
  let refreshing = $derived(syncState.fetching);
  let pendingAction = $state<string | null>(null);
  let errorMessage = $state('');
  let notice = $state('');
  let offlineStorageWarning = $state(false);
  let offlineStorageMessage = $state('');
  let clearingDeviceData = $state(false);
  let updateAvailable = $state(false);
  let reloadingForUpdate = $state(false);
  let existingEntryId = $state<string | null>(null);
  let purchasedExpanded = $state(false);
  let addFormOpen = $state(false);
  let groupOrderEditing = $state(false);
  let collapsedGroupIds = $state<string[]>([]);

  let addName = $state('');
  let addQuantity = $state('');
  let addNote = $state('');
  let addGroupIds = $state<string[]>([]);

  let editingEntryId = $state<string | null>(null);
  let editingEntryGroupId = $state<string | null>(null);
  let editName = $state('');
  let editQuantity = $state('');
  let editNote = $state('');
  let editGroupIds = $state<string[]>([]);

  let newGroupName = $state('');
  let newGroupKind = $state<'category' | 'store'>('category');
  let newGroupColor = $state(DEFAULT_GROUP_COLOR);
  let editingGroupId = $state<string | null>(null);
  let renameGroupName = $state('');
  let renameGroupColor = $state(DEFAULT_GROUP_COLOR);

  let historyItems = $state<PurchaseHistoryPage['items']>([]);
  let historyCursor = $state<string | null>(null);
  let historyLoaded = $state(false);
  let historyLoading = $state(false);
  let historyError = $state('');
  let cacheWritesSuppressed = false;
  let persistedAt: number | null = null;
  let cacheWriteQueue: Promise<void> = Promise.resolve();
  let waitingWorker: ServiceWorker | null = null;

  const canWrite = $derived(
    snapshot !== null &&
      connectionState === 'online' &&
      pendingAction === null &&
      !reloadingForUpdate,
  );
  const hasOpenDraft = $derived(
    Boolean(
      addName.trim() ||
      addQuantity ||
      addNote ||
      editingEntryId ||
      newGroupName.trim() ||
      editingGroupId,
    ),
  );
  const activeEntries = $derived.by(() =>
    (snapshot?.entries ?? []).filter((entry) => entry.status === 'active'),
  );
  const purchasedEntries = $derived.by(() =>
    (snapshot?.entries ?? []).filter((entry) => entry.status === 'purchased'),
  );
  const activeEntrySections = $derived.by(() => {
    const groups = snapshot?.groups ?? [];
    const ungroupedEntries = activeEntries.filter(
      (entry) => entry.groupIds.length === 0,
    );
    const sections: ActiveEntrySection[] = groups.map((group) => ({
      id: group.id,
      name: group.name,
      groupId: group.id,
      color: group.color,
      entries: activeEntries.filter((entry) =>
        entry.groupIds.includes(group.id),
      ),
    }));

    if (ungroupedEntries.length > 0 || groups.length === 0) {
      sections.push({
        id: UNGROUPED_SECTION_ID,
        name: 'Ungrouped',
        groupId: null,
        color: DEFAULT_GROUP_COLOR,
        entries: ungroupedEntries,
      });
    }

    return sections;
  });
  const connectionLabel = $derived.by(() => {
    if (
      snapshot &&
      lastVerifiedAt &&
      (syncState.cachedSnapshot || syncState.offline)
    ) {
      return `Offline — last refreshed ${new Date(lastVerifiedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    if (connectionState === 'connecting')
      return 'Connecting to the shared list…';
    if (connectionState === 'syncing') return 'Syncing the latest list…';
    if (connectionState === 'online') {
      return lastVerifiedAt
        ? `Connected · updated ${new Date(lastVerifiedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Connected';
    }
    if (connectionState === 'unavailable' && lastVerifiedAt) {
      return `Unavailable · last refreshed ${new Date(lastVerifiedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    }
    return 'Unavailable · connect to load the list';
  });

  onMount(() => {
    let registration: ServiceWorkerRegistration | null = null;
    const unsubscribe = snapshotCoordinator.subscribe((state) => {
      syncState = state;
      if (
        state.status === 'online' &&
        state.snapshot &&
        state.lastVerifiedAt !== null &&
        state.lastVerifiedAt !== persistedAt
      ) {
        persistedAt = state.lastVerifiedAt;
        const snapshotToSave = state.snapshot;
        const verifiedAt = state.lastVerifiedAt;
        cacheWriteQueue = cacheWriteQueue
          .then(async () => {
            if (cacheWritesSuppressed) return;
            await saveOfflineSnapshot(snapshotToSave, verifiedAt);
            offlineStorageWarning = false;
            offlineStorageMessage = '';
          })
          .catch(() => {
            offlineStorageWarning = true;
            offlineStorageMessage =
              'Offline viewing is unavailable because this browser could not save the list.';
          });
      }
    });
    let timer: number | undefined;
    let retryDelay = 3000;

    function handleServiceWorkerMessage(event: MessageEvent): void {
      if (event.data?.type !== 'SHOPPING_LIST_UPDATE_READY') return;
      updateAvailable = true;
      void navigator.serviceWorker
        .getRegistration()
        .then((currentRegistration) => {
          registration = currentRegistration ?? null;
          waitingWorker = registration?.waiting ?? null;
        });
    }

    function handleControllerChange(): void {
      if (reloadingForUpdate) updateAvailable = false;
    }

    function scheduleNextPoll(): void {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      timer = window.setTimeout(async () => {
        const current = await snapshotCoordinator.refresh();
        retryDelay = current ? 3000 : Math.min(retryDelay * 2, 30_000);
        scheduleNextPoll();
      }, retryDelay);
    }

    function resumeAndRefresh(): void {
      if (document.visibilityState === 'hidden') return;
      retryDelay = 3000;
      void snapshotCoordinator.refresh(true).then((current) => {
        retryDelay = current ? 3000 : 6000;
        scheduleNextPoll();
      });
    }

    function handleVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        return;
      }
      resumeAndRefresh();
    }

    window.addEventListener('focus', resumeAndRefresh);
    window.addEventListener('online', resumeAndRefresh);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener(
        'message',
        handleServiceWorkerMessage,
      );
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        handleControllerChange,
      );
      void navigator.serviceWorker.ready.then((readyRegistration) => {
        registration = readyRegistration;
        if (registration.waiting) {
          waitingWorker = registration.waiting;
          updateAvailable = true;
        }
        registration.addEventListener('updatefound', () => {
          const installingWorker = registration?.installing;
          installingWorker?.addEventListener('statechange', () => {
            if (
              installingWorker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              waitingWorker = registration?.waiting ?? installingWorker;
              updateAvailable = true;
            }
          });
        });
      });
    }

    void (async () => {
      try {
        const local = await loadOfflineSnapshot();
        if (local.incompatible) {
          offlineStorageWarning = true;
          offlineStorageMessage =
            'The saved offline list was from an older version and has been cleared. Connect to reload it.';
        }
        if (local.snapshot && local.lastVerifiedAt !== null) {
          persistedAt = local.lastVerifiedAt;
          snapshotCoordinator.restoreCachedSnapshot(
            local.snapshot,
            local.lastVerifiedAt,
          );
        }
      } catch {
        offlineStorageWarning = true;
        offlineStorageMessage =
          'Offline viewing is unavailable because this browser could not open local storage.';
      }
      const current = await snapshotCoordinator.refresh(true);
      retryDelay = current ? 3000 : 6000;
      scheduleNextPoll();
    })();

    return () => {
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener('focus', resumeAndRefresh);
      window.removeEventListener('online', resumeAndRefresh);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener(
          'message',
          handleServiceWorkerMessage,
        );
        navigator.serviceWorker.removeEventListener(
          'controllerchange',
          handleControllerChange,
        );
      }
    };
  });

  function refreshSnapshot(): Promise<boolean> {
    return snapshotCoordinator.refresh(true);
  }

  async function openAddForm(): Promise<void> {
    addFormOpen = true;
    errorMessage = '';
    await tick();
    document.getElementById('new-item-name')?.focus();
  }

  async function clearThisDeviceData(): Promise<void> {
    if (
      !window.confirm(
        'Clear this browser’s saved list and app files? This does not change the shared list. Offline reopening will require another successful online visit.',
      )
    ) {
      return;
    }

    clearingDeviceData = true;
    cacheWritesSuppressed = true;
    try {
      await cacheWriteQueue;
      await clearOfflineData();
      persistedAt = null;
      offlineStorageWarning = false;
      offlineStorageMessage = '';
      notice =
        'This device’s saved data was cleared. Offline reopening requires another successful online visit.';
    } catch {
      cacheWritesSuppressed = false;
      offlineStorageWarning = true;
      offlineStorageMessage =
        'Some saved data could not be cleared. Check this browser’s site data settings.';
    } finally {
      clearingDeviceData = false;
    }
  }

  async function reloadForUpdate(): Promise<void> {
    if (hasOpenDraft || !('serviceWorker' in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = registration?.waiting ?? waitingWorker;
    if (!worker) {
      updateAvailable = false;
      return;
    }

    reloadingForUpdate = true;
    await new Promise<void>((resolve) => {
      const onControllerChange = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        onControllerChange,
        {
          once: true,
        },
      );
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          'controllerchange',
          onControllerChange,
        );
        resolve();
      }, 5000);
      worker.postMessage({ type: 'SHOPPING_LIST_SKIP_WAITING' });
    });
    window.location.reload();
  }

  async function mutate(
    path: string,
    method: string,
    payload: Record<string, unknown>,
    activity: string,
  ): Promise<boolean> {
    if (!snapshot || !canWrite) return false;
    pendingAction = activity;
    errorMessage = '';
    notice = '';
    existingEntryId = null;
    try {
      const result = await requestJson<{
        serverInstanceId: string;
        revision: number;
      }>(path, { method, body: payload });
      snapshotCoordinator.requireRevision(
        result.serverInstanceId,
        result.revision,
      );
      const refreshed = await refreshSnapshot();
      const current = snapshotCoordinator.getState().snapshot;
      if (
        refreshed &&
        current?.serverInstanceId === result.serverInstanceId &&
        current.revision >= result.revision
      ) {
        notice = 'Saved.';
      } else {
        errorMessage =
          'Saved, but the latest list could not be loaded. Refresh before making another change.';
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError) {
        errorMessage = error.message;
        const entryId = error.details?.entryId;
        if (typeof entryId === 'string') existingEntryId = entryId;
        if (error.status === 409) await refreshSnapshot();
      } else {
        errorMessage =
          'Save unconfirmed. Refresh the list to check before trying again.';
        await refreshSnapshot();
      }
      return false;
    } finally {
      pendingAction = null;
    }
  }

  function setAddName(value: string): void {
    addName = value;
    const normalized = normalizeName(value);
    const remembered = snapshot?.catalogItems.find(
      (item) => normalizeName(item.name) === normalized,
    );
    const nextGroupIds = [...(remembered?.defaultGroupIds ?? [])];
    const liveGroupIds = new Set(
      snapshot?.groups.map((group) => group.id) ?? [],
    );
    addGroupIds = [...new Set(nextGroupIds)].filter((id) =>
      liveGroupIds.has(id),
    );
  }

  function toggleGroup(ids: string[], groupId: string): string[] {
    return ids.includes(groupId)
      ? ids.filter((id) => id !== groupId)
      : [...ids, groupId];
  }

  function toggleGroupCollapsed(sectionId: string): void {
    collapsedGroupIds = toggleGroup(collapsedGroupIds, sectionId);
  }

  async function submitAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!snapshot) return;
    const saved = await mutate(
      '/api/entries',
      'POST',
      {
        id: crypto.randomUUID(),
        serverInstanceId: snapshot.serverInstanceId,
        name: addName,
        quantityText: addQuantity,
        note: addNote,
        groupIds: addGroupIds,
      },
      'add',
    );
    if (saved) {
      addName = '';
      addQuantity = '';
      addNote = '';
      addGroupIds = [];
      addFormOpen = false;
    }
  }

  function beginEdit(
    entry: Snapshot['entries'][number],
    groupId: string | null,
  ): void {
    editingEntryId = entry.id;
    editingEntryGroupId = groupId;
    editName = entry.name;
    editQuantity = entry.quantityText ?? '';
    editNote = entry.note ?? '';
    editGroupIds = [...entry.groupIds];
    errorMessage = '';
  }

  async function submitEdit(
    event: SubmitEvent,
    entryId: string,
  ): Promise<void> {
    event.preventDefault();
    if (!snapshot) return;
    const entry = snapshot.entries.find((item) => item.id === entryId);
    if (!entry) return;
    const saved = await mutate(
      `/api/entries/${entryId}`,
      'PATCH',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: entry.revision,
        name: editName,
        quantityText: editQuantity,
        note: editNote,
        groupIds: editGroupIds,
      },
      `edit:${entryId}`,
    );
    if (saved) {
      editingEntryId = null;
      editingEntryGroupId = null;
    }
  }

  async function removeEntry(entryId: string): Promise<void> {
    if (!snapshot) return;
    const entry = snapshot.entries.find((item) => item.id === entryId);
    if (!entry || !window.confirm(`Remove ${entry.name} from the active list?`))
      return;
    await mutate(
      `/api/entries/${entryId}/cancel`,
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: entry.revision,
      },
      `cancel:${entryId}`,
    );
  }

  async function purchaseEntry(
    entryId: string,
    groupId: string | null,
  ): Promise<void> {
    if (!snapshot) return;
    const entry = snapshot.entries.find((item) => item.id === entryId);
    if (!entry) return;
    const group = snapshot.groups.find((item) => item.id === groupId);
    const actualStoreId = group?.kind === 'store' ? group.id : null;
    await mutate(
      `/api/entries/${entryId}/purchase`,
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: entry.revision,
        storeGroupId: actualStoreId,
      },
      `purchase:${entryId}`,
    );
  }

  async function undoPurchase(entryId: string): Promise<void> {
    if (!snapshot) return;
    const entry = snapshot.entries.find((item) => item.id === entryId);
    if (!entry) return;
    await mutate(
      `/api/entries/${entryId}/undo`,
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: entry.revision,
      },
      `undo:${entryId}`,
    );
  }

  async function clearPurchased(): Promise<void> {
    if (!snapshot || purchasedEntries.length === 0) return;
    if (
      !window.confirm(
        `Clear these ${purchasedEntries.length} purchased item(s) from the list? Their purchase history will be kept.`,
      )
    ) {
      return;
    }
    await mutate(
      '/api/entries/archive',
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        entries: purchasedEntries.map((entry) => ({
          id: entry.id,
          expectedRevision: entry.revision,
        })),
      },
      'clear',
    );
  }

  function groupNames(groupIds: string[]) {
    return (snapshot?.groups ?? []).filter((group) =>
      groupIds.includes(group.id),
    );
  }

  function formatDate(value: string): string {
    return new Date(value).toLocaleString([], {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  async function showExistingEntry(): Promise<void> {
    if (!existingEntryId) return;
    const entryId = existingEntryId;
    screen = 'list';
    await tick();
    document
      .querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function openScreen(nextScreen: Screen): Promise<void> {
    screen = nextScreen;
    menuOpen = false;
    errorMessage = '';
    if (nextScreen !== 'list') groupOrderEditing = false;
    if (nextScreen === 'history' && !historyLoaded) await loadHistory(true);
  }

  async function loadHistory(reset: boolean): Promise<void> {
    if (historyLoading) return;
    historyLoading = true;
    historyError = '';
    try {
      const cursor = reset ? null : historyCursor;
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await requestJson<PurchaseHistoryPage>(
        `/api/purchases${query}`,
      );
      historyItems = reset ? page.items : [...historyItems, ...page.items];
      historyCursor = page.nextCursor;
      historyLoaded = true;
    } catch {
      historyError = 'Purchase history is unavailable. Refresh and try again.';
    } finally {
      historyLoading = false;
    }
  }

  async function submitCreateGroup(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!snapshot) return;
    const saved = await mutate(
      '/api/groups',
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        name: newGroupName,
        kind: newGroupKind,
        color: newGroupColor,
      },
      'create-group',
    );
    if (saved) {
      newGroupName = '';
      newGroupColor = DEFAULT_GROUP_COLOR;
    }
  }

  function beginRenameGroup(
    groupId: string,
    name: string,
    color: string,
  ): void {
    editingGroupId = groupId;
    renameGroupName = name;
    renameGroupColor = color;
    errorMessage = '';
  }

  async function submitRenameGroup(
    event: SubmitEvent,
    groupId: string,
  ): Promise<void> {
    event.preventDefault();
    if (!snapshot) return;
    const group = snapshot.groups.find((item) => item.id === groupId);
    if (!group) return;
    const saved = await mutate(
      `/api/groups/${groupId}`,
      'PATCH',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: group.revision,
        name: renameGroupName,
        color: renameGroupColor,
      },
      `rename-group:${groupId}`,
    );
    if (saved) editingGroupId = null;
  }

  async function archiveGroup(groupId: string): Promise<void> {
    if (!snapshot) return;
    const group = snapshot.groups.find((item) => item.id === groupId);
    if (
      !group ||
      !window.confirm(
        `Archive ${group.name}? Items will stay on the list without this group.`,
      )
    ) {
      return;
    }
    await mutate(
      `/api/groups/${groupId}/archive`,
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        expectedRevision: group.revision,
      },
      `archive-group:${groupId}`,
    );
  }

  async function moveGroup(groupId: string, direction: -1 | 1): Promise<void> {
    if (!snapshot) return;
    const groups = [...snapshot.groups];
    const index = groups.findIndex((group) => group.id === groupId);
    const destination = index + direction;
    if (index < 0 || destination < 0 || destination >= groups.length) return;
    [groups[index], groups[destination]] = [groups[destination], groups[index]];
    await mutate(
      '/api/groups/reorder',
      'POST',
      {
        serverInstanceId: snapshot.serverInstanceId,
        groups: groups.map((group, position) => ({
          id: group.id,
          expectedRevision: group.revision,
          position,
        })),
      },
      'reorder-groups',
    );
  }
</script>

<svelte:head>
  <title>Shopping list</title>
  <meta
    name="description"
    content="A shared shopping list for your household."
  />
</svelte:head>

<main class="app-shell">
  <h1 class="sr-only">Shopping list</h1>

  <div class="app-toolbar">
    {#if screen === 'list' && snapshot}
      <p class="eyebrow toolbar-list-name">{snapshot.list.name}</p>
    {/if}
    <div class="menu-actions">
      {#if screen === 'list' && snapshot}
        <button
          class="add-open-button"
          type="button"
          aria-label="Open add item form"
          aria-expanded={addFormOpen}
          onclick={() => (addFormOpen ? (addFormOpen = false) : openAddForm())}
          disabled={!canWrite}
        >
          <span aria-hidden="true">+</span>
        </button>
        {#if snapshot.groups.length > 1}
          <button
            class="add-open-button group-edit-toggle"
            type="button"
            aria-label={groupOrderEditing
              ? 'Finish editing group order'
              : 'Edit group order'}
            aria-pressed={groupOrderEditing}
            disabled={!canWrite}
            onclick={() => (groupOrderEditing = !groupOrderEditing)}
          >
            <svg
              class="edit-icon"
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              focusable="false"
            >
              <path
                d="m14.5 5.5 4 4M4 20l4.2-1 11.1-11.1a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.8"
              />
            </svg>
          </button>
        {/if}
      {/if}
      <button
        class="menu-toggle"
        type="button"
        aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        aria-controls="main-navigation"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <svg
          class="menu-icon"
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          focusable="false"
        >
          <path
            d="M4 6h16M4 12h16M4 18h16"
            stroke="currentColor"
            stroke-linecap="square"
            stroke-width="2"
          />
        </svg>
      </button>
    </div>
    <nav
      class="main-nav"
      id="main-navigation"
      aria-label="Main navigation"
      hidden={!menuOpen}
    >
      <button
        class:active={screen === 'list'}
        aria-current={screen === 'list' ? 'page' : undefined}
        onclick={() => openScreen('list')}
      >
        List
      </button>
      <button
        class:active={screen === 'groups'}
        aria-current={screen === 'groups' ? 'page' : undefined}
        onclick={() => openScreen('groups')}
      >
        Groups
      </button>
      <button
        class:active={screen === 'history'}
        aria-current={screen === 'history' ? 'page' : undefined}
        onclick={() => openScreen('history')}
      >
        Purchase history
      </button>
    </nav>
  </div>

  {#if updateAvailable}
    <div class="update-banner" role="status">
      <span>
        {hasOpenDraft
          ? 'An app update is ready. Save or cancel your open draft before reloading.'
          : 'An app update is ready to install.'}
      </span>
      <button
        class="quiet-button"
        disabled={hasOpenDraft || reloadingForUpdate}
        onclick={reloadForUpdate}
      >
        {reloadingForUpdate ? 'Updating…' : 'Reload to update'}
      </button>
    </div>
  {/if}

  {#if offlineStorageWarning}
    <p class="cache-warning" role="status">{offlineStorageMessage}</p>
  {/if}

  {#if errorMessage}
    <div class="message error-message" role="alert">
      <span>{errorMessage}</span>
      {#if existingEntryId}
        <button class="text-button" onclick={showExistingEntry}
          >Open the item</button
        >
      {/if}
    </div>
  {:else if notice}
    <p class="message success-message" role="status">{notice}</p>
  {/if}

  {#if snapshot && connectionState !== 'online'}
    <div class="offline-banner" role="status">
      {#if syncState.cachedSnapshot || syncState.offline}
        <strong>
          Offline — last refreshed
          {lastVerifiedAt
            ? new Date(lastVerifiedAt).toLocaleString([], {
                dateStyle: 'medium',
                timeStyle: 'short',
              })
            : 'unknown'}
        </strong>
        <span
          >This saved list is read-only until the server verifies a refresh.</span
        >
      {:else if connectionState === 'unavailable'}
        <strong>Server unavailable — list may be stale.</strong>
        <span>Changes are disabled until the server verifies a refresh.</span>
      {:else}
        <strong>Checking the shared list…</strong>
        <span
          >Changes are disabled until the server confirms the latest data.</span
        >
      {/if}
    </div>
  {/if}

  {#if !snapshot}
    <section class="empty-state" aria-live="polite">
      <div class="empty-mark" aria-hidden="true">✓</div>
      <h2>
        {connectionState === 'connecting'
          ? 'Loading your list'
          : 'No saved list available'}
      </h2>
      <p>
        {connectionState === 'connecting'
          ? 'Connecting to the shared household list…'
          : 'Connect to the household network, then refresh to load the list.'}
      </p>
      {#if connectionState === 'unavailable'}
        <button
          class="primary-button"
          onclick={() => refreshSnapshot()}
          disabled={refreshing}
        >
          Try again
        </button>
      {/if}
    </section>
  {:else if screen === 'list'}
    <section class="list-screen" aria-label="Current shopping list">
      {#if addFormOpen}
        <form class="add-card" onsubmit={submitAdd}>
          <div class="add-name-row">
            <label class="field grow">
              <span class="sr-only">Item name</span>
              <input
                id="new-item-name"
                name="name"
                value={addName}
                oninput={(event) => setAddName(event.currentTarget.value)}
                list="item-suggestions"
                maxlength="120"
                placeholder="Add an item…"
                autocomplete="off"
                required
                disabled={!canWrite}
              />
              <datalist id="item-suggestions">
                {#each snapshot.catalogItems as item (item.id)}
                  <option value={item.name}></option>
                {/each}
              </datalist>
            </label>
            <button
              class="primary-button add-button"
              type="submit"
              disabled={!canWrite || !addName.trim()}
            >
              {pendingAction === 'add' ? 'Adding…' : 'Add item'}
            </button>
            <button
              class="quiet-button"
              type="button"
              onclick={() => (addFormOpen = false)}
            >
              Close
            </button>
          </div>

          <details class="item-details">
            <summary>Quantity, note, and groups</summary>
            <div class="details-fields">
              <label class="field">
                <span>Quantity</span>
                <input
                  bind:value={addQuantity}
                  maxlength="80"
                  placeholder="e.g. 2 dozen"
                  disabled={!canWrite}
                />
              </label>
              <label class="field">
                <span>Note</span>
                <textarea
                  bind:value={addNote}
                  maxlength="1000"
                  rows="2"
                  placeholder="Optional details"
                  disabled={!canWrite}></textarea>
              </label>
              <fieldset class="group-choices">
                <legend>Groups</legend>
                {#if snapshot.groups.length}
                  <div class="choice-list">
                    {#each snapshot.groups as group (group.id)}
                      <label class="choice">
                        <input
                          type="checkbox"
                          checked={addGroupIds.includes(group.id)}
                          onchange={() =>
                            (addGroupIds = toggleGroup(addGroupIds, group.id))}
                          disabled={!canWrite}
                        />
                        <span>{group.name}</span>
                      </label>
                    {/each}
                  </div>
                {:else}
                  <p class="muted">Create groups to organize the list.</p>
                {/if}
              </fieldset>
            </div>
          </details>
        </form>
      {/if}

      <section class="entry-section" aria-label="Items grouped by list">
        {#each activeEntrySections as entrySection (entrySection.id)}
          {@const groupIsCollapsed = collapsedGroupIds.includes(
            entrySection.id,
          )}
          <section
            class="group-list-section"
            aria-labelledby={`group-heading-${entrySection.id}`}
            style={`--group-color: ${entrySection.color}`}
          >
            <div class="group-list-heading">
              <div class="group-heading-title">
                <button
                  class="group-collapse-toggle"
                  type="button"
                  aria-label={`${groupIsCollapsed ? 'Expand' : 'Collapse'} ${entrySection.name}`}
                  aria-expanded={!groupIsCollapsed}
                  aria-controls={`group-content-${entrySection.id}`}
                  onclick={() => toggleGroupCollapsed(entrySection.id)}
                >
                  <span aria-hidden="true">{groupIsCollapsed ? '▸' : '▾'}</span>
                </button>
                <h2 id={`group-heading-${entrySection.id}`}>
                  {entrySection.name}
                </h2>
              </div>
              <div class="group-heading-tools">
                <span class="count">{entrySection.entries.length}</span>
                {#if entrySection.groupId && groupOrderEditing}
                  <div
                    class="group-order-controls"
                    role="group"
                    aria-label={`Reorder ${entrySection.name}`}
                  >
                    <button
                      class="group-order-button"
                      type="button"
                      aria-label={`Move ${entrySection.name} up`}
                      title={`Move ${entrySection.name} up`}
                      disabled={!canWrite ||
                        snapshot.groups[0]?.id === entrySection.groupId}
                      onclick={() => moveGroup(entrySection.groupId!, -1)}
                    >
                      <span aria-hidden="true">↑</span>
                    </button>
                    <button
                      class="group-order-button"
                      type="button"
                      aria-label={`Move ${entrySection.name} down`}
                      title={`Move ${entrySection.name} down`}
                      disabled={!canWrite ||
                        snapshot.groups[snapshot.groups.length - 1]?.id ===
                          entrySection.groupId}
                      onclick={() => moveGroup(entrySection.groupId!, 1)}
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
            <div
              class="group-list-content"
              id={`group-content-${entrySection.id}`}
              hidden={groupIsCollapsed}
            >
              {#if entrySection.entries.length}
                <ul class="entry-list">
                  {#each entrySection.entries as entry (entry.id)}
                    <li
                      class="entry-card"
                      id={`entry-${entry.id}-${entrySection.id}`}
                      data-entry-id={entry.id}
                    >
                      {#if editingEntryId === entry.id && editingEntryGroupId === entrySection.groupId}
                        <form
                          class="edit-form"
                          onsubmit={(event) => submitEdit(event, entry.id)}
                        >
                          <label class="field">
                            <span>Item name</span>
                            <input
                              bind:value={editName}
                              maxlength="120"
                              required
                              disabled={!canWrite}
                            />
                          </label>
                          <div class="details-fields">
                            <label class="field">
                              <span>Quantity</span>
                              <input
                                bind:value={editQuantity}
                                maxlength="80"
                                disabled={!canWrite}
                              />
                            </label>
                            <label class="field">
                              <span>Note</span>
                              <textarea
                                bind:value={editNote}
                                maxlength="1000"
                                rows="2"
                                disabled={!canWrite}></textarea>
                            </label>
                          </div>
                          <fieldset class="group-choices">
                            <legend>Groups</legend>
                            <div class="choice-list">
                              {#each snapshot.groups as group (group.id)}
                                <label class="choice">
                                  <input
                                    type="checkbox"
                                    checked={editGroupIds.includes(group.id)}
                                    onchange={() =>
                                      (editGroupIds = toggleGroup(
                                        editGroupIds,
                                        group.id,
                                      ))}
                                    disabled={!canWrite}
                                  />
                                  <span>{group.name}</span>
                                </label>
                              {/each}
                            </div>
                          </fieldset>
                          <div class="row-actions">
                            <button
                              class="primary-button"
                              type="submit"
                              disabled={!canWrite}
                            >
                              {pendingAction === `edit:${entry.id}`
                                ? 'Saving…'
                                : 'Save changes'}
                            </button>
                            <button
                              class="quiet-button"
                              type="button"
                              onclick={() => {
                                editingEntryId = null;
                                editingEntryGroupId = null;
                              }}>Cancel</button
                            >
                          </div>
                        </form>
                      {:else}
                        <div class="entry-main">
                          <button
                            class="purchase-toggle"
                            role="checkbox"
                            aria-checked="false"
                            aria-label={`Mark ${entry.name} as purchased in ${entrySection.name}`}
                            disabled={!canWrite}
                            onclick={() =>
                              purchaseEntry(entry.id, entrySection.groupId)}
                          >
                            <span aria-hidden="true">✓</span>
                          </button>
                          <div class="entry-copy">
                            <div class="entry-title-row">
                              <strong>{entry.name}</strong>
                              {#if entry.quantityText}<span class="quantity"
                                  >{entry.quantityText}</span
                                >{/if}
                            </div>
                            {#if entry.note}
                              <details class="entry-note">
                                <summary>Note</summary>
                                <p>{entry.note}</p>
                              </details>
                            {/if}
                          </div>
                          <div class="entry-actions">
                            <button
                              class="quiet-button"
                              aria-label={`Edit ${entry.name}`}
                              title={`Edit ${entry.name}`}
                              disabled={!canWrite}
                              onclick={() =>
                                beginEdit(entry, entrySection.groupId)}
                            >
                              <svg
                                class="entry-action-icon"
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                focusable="false"
                              >
                                <path
                                  d="m14.5 5.5 4 4M4 20l4.2-1 11.1-11.1a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"
                                  stroke="currentColor"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  stroke-width="1.8"
                                />
                              </svg>
                            </button>
                            <button
                              class="quiet-button danger-text"
                              aria-label={`Remove ${entry.name}`}
                              title={`Remove ${entry.name}`}
                              disabled={!canWrite}
                              onclick={() => removeEntry(entry.id)}
                            >
                              <svg
                                class="entry-action-icon"
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                focusable="false"
                              >
                                <path
                                  d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13M10 11v5m4-5v5"
                                  stroke="currentColor"
                                  stroke-linecap="square"
                                  stroke-linejoin="miter"
                                  stroke-width="1.8"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="empty-list group-empty">
                  {entrySection.groupId
                    ? `Nothing to buy in ${entrySection.name} yet.`
                    : 'Nothing to buy yet.'}
                </p>
              {/if}
            </div>
          </section>
        {/each}
      </section>

      <section class="purchased-section" aria-labelledby="purchased-heading">
        <button
          class="purchased-toggle"
          aria-expanded={purchasedExpanded}
          aria-controls="purchased-list"
          onclick={() => (purchasedExpanded = !purchasedExpanded)}
        >
          <span class="purchased-title">
            <span class="chevron" aria-hidden="true"
              >{purchasedExpanded ? '▾' : '▸'}</span
            >
            <span id="purchased-heading">Purchased</span>
            <span class="count">{purchasedEntries.length}</span>
          </span>
          {#if purchasedEntries.length}
            <span class="clear-label"
              >Clear {purchasedEntries.length} purchased</span
            >
          {/if}
        </button>
        {#if purchasedExpanded}
          <div id="purchased-list" class="purchased-content">
            {#if purchasedEntries.length}
              <ul class="entry-list">
                {#each purchasedEntries as entry (entry.id)}
                  <li
                    class="entry-card purchased-card"
                    id={`entry-${entry.id}`}
                  >
                    <div class="purchased-check" aria-hidden="true">✓</div>
                    <div class="entry-copy">
                      <div class="entry-title-row">
                        <strong>{entry.name}</strong>
                        {#if entry.quantityText}<span class="quantity"
                            >{entry.quantityText}</span
                          >{/if}
                      </div>
                      {#if entry.purchase?.storeNameSnapshot}
                        <p class="purchase-store">
                          Bought at {entry.purchase.storeNameSnapshot}
                        </p>
                      {/if}
                      {#if entry.purchase?.purchasedAt}
                        <p class="muted">
                          {formatDate(entry.purchase.purchasedAt)}
                        </p>
                      {/if}
                      {#if entry.groupIds.length}
                        <div class="badges" aria-label="Assigned groups">
                          {#each groupNames(entry.groupIds) as group (group.id)}
                            <span
                              class="badge"
                              style={`--group-color: ${group.color}`}
                              >{group.name}</span
                            >
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <button
                      class="quiet-button"
                      aria-label={`Undo purchase of ${entry.name}`}
                      disabled={!canWrite}
                      onclick={() => undoPurchase(entry.id)}>Undo</button
                    >
                  </li>
                {/each}
              </ul>
              <button
                class="clear-button"
                disabled={!canWrite}
                onclick={clearPurchased}
              >
                Clear {purchasedEntries.length} purchased
              </button>
            {:else}
              <p class="empty-list">No purchased items in this view.</p>
            {/if}
          </div>
        {/if}
      </section>
    </section>
  {:else if screen === 'groups'}
    <section class="secondary-screen" aria-labelledby="groups-heading">
      <div class="list-heading">
        <div>
          <p class="eyebrow">Organize your list</p>
          <h2 id="groups-heading">Groups</h2>
        </div>
      </div>
      <form class="add-card group-create" onsubmit={submitCreateGroup}>
        <label class="field grow">
          <span>New group name</span>
          <input
            bind:value={newGroupName}
            maxlength="80"
            placeholder="e.g. Market or Camping"
            required
            disabled={!canWrite}
          />
        </label>
        <label class="field group-kind-field">
          <span>Type</span>
          <select bind:value={newGroupKind} disabled={!canWrite}>
            <option value="category">Category</option>
            <option value="store">Store</option>
          </select>
        </label>
        <label class="field group-color-field">
          <span>Color</span>
          <input
            type="color"
            aria-label="New group color"
            bind:value={newGroupColor}
            disabled={!canWrite}
          />
        </label>
        <button
          class="primary-button"
          type="submit"
          disabled={!canWrite || !newGroupName.trim()}
        >
          {pendingAction === 'create-group' ? 'Creating…' : 'Create group'}
        </button>
      </form>
      {#if snapshot.groups.length}
        <ol class="manage-list">
          {#each snapshot.groups as group, index (group.id)}
            <li class="manage-card">
              {#if editingGroupId === group.id}
                <form
                  class="rename-form"
                  onsubmit={(event) => submitRenameGroup(event, group.id)}
                >
                  <label class="field grow">
                    <span>Group name</span>
                    <input
                      bind:value={renameGroupName}
                      maxlength="80"
                      required
                      disabled={!canWrite}
                    />
                  </label>
                  <label class="field group-color-field">
                    <span>Color</span>
                    <input
                      type="color"
                      aria-label={`Color for ${group.name}`}
                      bind:value={renameGroupColor}
                      disabled={!canWrite}
                    />
                  </label>
                  <div class="row-actions">
                    <button
                      class="primary-button"
                      type="submit"
                      disabled={!canWrite}>Save</button
                    >
                    <button
                      class="quiet-button"
                      type="button"
                      onclick={() => (editingGroupId = null)}>Cancel</button
                    >
                  </div>
                </form>
              {:else}
                <div class="manage-title">
                  <div>
                    <strong>{group.name}</strong>
                    <span
                      class="kind-label"
                      style={`--group-color: ${group.color}`}
                      >{group.kind === 'store' ? 'Store' : 'Category'}</span
                    >
                  </div>
                  <div class="manage-actions">
                    <button
                      class="quiet-button"
                      aria-label={`Move ${group.name} up`}
                      title={`Move ${group.name} up`}
                      disabled={!canWrite || index === 0}
                      onclick={() => moveGroup(group.id, -1)}
                    >
                      <svg
                        class="group-action-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        focusable="false"
                      >
                        <path
                          d="M12 19V5m0 0-5 5m5-5 5 5"
                          stroke="currentColor"
                          stroke-linecap="square"
                          stroke-linejoin="miter"
                          stroke-width="1.8"
                        />
                      </svg>
                    </button>
                    <button
                      class="quiet-button"
                      aria-label={`Move ${group.name} down`}
                      title={`Move ${group.name} down`}
                      disabled={!canWrite ||
                        index === snapshot.groups.length - 1}
                      onclick={() => moveGroup(group.id, 1)}
                    >
                      <svg
                        class="group-action-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        focusable="false"
                      >
                        <path
                          d="M12 5v14m0 0 5-5m-5 5-5-5"
                          stroke="currentColor"
                          stroke-linecap="square"
                          stroke-linejoin="miter"
                          stroke-width="1.8"
                        />
                      </svg>
                    </button>
                    <button
                      class="quiet-button"
                      aria-label={`Edit ${group.name}`}
                      title={`Edit ${group.name}`}
                      disabled={!canWrite}
                      onclick={() =>
                        beginRenameGroup(group.id, group.name, group.color)}
                    >
                      <svg
                        class="group-action-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        focusable="false"
                      >
                        <path
                          d="m14.5 5.5 4 4M4 20l4.2-1 11.1-11.1a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"
                          stroke="currentColor"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="1.8"
                        />
                      </svg>
                    </button>
                    <button
                      class="quiet-button danger-text"
                      aria-label={`Archive ${group.name}`}
                      title={`Archive ${group.name}`}
                      disabled={!canWrite}
                      onclick={() => archiveGroup(group.id)}
                    >
                      <svg
                        class="group-action-icon"
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        focusable="false"
                      >
                        <path
                          d="M3 5h18v4H3zM5 9v11h14V9m-9 4h4"
                          stroke="currentColor"
                          stroke-linecap="square"
                          stroke-linejoin="miter"
                          stroke-width="1.8"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {:else}
        <p class="empty-list">
          No groups yet. Groups can represent stores or any category you like.
        </p>
      {/if}
    </section>
  {:else}
    <section class="secondary-screen" aria-labelledby="history-heading">
      <div class="list-heading">
        <div>
          <p class="eyebrow">Kept when you clear purchased items</p>
          <h2 id="history-heading">Purchase history</h2>
        </div>
      </div>
      {#if historyError}<p class="message error-message" role="alert">
          {historyError}
        </p>{/if}
      {#if historyItems.length}
        <ul class="history-list">
          {#each historyItems as purchase (purchase.id)}
            <li class="history-card">
              <div class="history-check" aria-hidden="true">✓</div>
              <div class="entry-copy">
                <div class="entry-title-row">
                  <strong>{purchase.name}</strong>
                  {#if purchase.quantityText}<span class="quantity"
                      >{purchase.quantityText}</span
                    >{/if}
                </div>
                <p class="muted">{formatDate(purchase.purchasedAt)}</p>
                {#if purchase.storeName}<p class="purchase-store">
                    Bought at {purchase.storeName}
                  </p>{/if}
              </div>
            </li>
          {/each}
        </ul>
        {#if historyCursor}
          <button
            class="secondary-button load-more"
            disabled={historyLoading}
            onclick={() => loadHistory(false)}
          >
            {historyLoading ? 'Loading…' : 'Load more history'}
          </button>
        {/if}
      {:else if historyLoading}
        <p class="empty-list">Loading purchase history…</p>
      {:else if historyLoaded && !historyError}
        <p class="empty-list">No purchases recorded yet.</p>
      {:else if !historyError}
        <button
          class="secondary-button"
          disabled={historyLoading}
          onclick={() => loadHistory(true)}>Load history</button
        >
      {/if}
    </section>
  {/if}

  <footer class="device-data">
    <div class="device-info">
      <p>
        Saved list data is private to this browser and can be cleared at any
        time.
      </p>
      <div class="connection" class:offline={connectionState === 'unavailable'}>
        <span class="connection-dot" aria-hidden="true"></span>
        <span role="status">{connectionLabel}</span>
        <button
          class="quiet-button refresh-button"
          onclick={() => refreshSnapshot()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
    </div>
    <button
      class="quiet-button"
      disabled={clearingDeviceData}
      onclick={clearThisDeviceData}
    >
      {clearingDeviceData ? 'Clearing…' : 'Clear this device’s saved data'}
    </button>
  </footer>
</main>

<style>
  .app-shell {
    width: min(100% - 2rem, 48rem);
    margin: 0 auto;
    padding: 1.5rem 0 4rem;
    color: var(--text);
  }

  .connection,
  .main-nav,
  .list-heading,
  .entry-main,
  .entry-title-row,
  .entry-actions,
  .row-actions,
  .manage-title,
  .manage-actions,
  .purchased-toggle,
  .purchased-title,
  .history-card {
    display: flex;
    align-items: center;
  }

  .list-heading,
  .entry-main,
  .purchased-toggle,
  .manage-title {
    justify-content: space-between;
  }

  .empty-mark {
    display: grid;
    width: 2.8rem;
    aspect-ratio: 1;
    place-items: center;
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--accent);
    background: linear-gradient(
      145deg,
      var(--surface-highlight),
      var(--surface)
    );
    font-size: 1.4rem;
    font-weight: 750;
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 4%);
  }

  .eyebrow {
    margin: 0 0 0.2rem;
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0;
    color: var(--text);
    font-family: var(--font-display);
    font-size: 1.35rem;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }

  h2 {
    margin-bottom: 0;
    color: var(--text);
    font-family: var(--font-display);
    font-size: 1.3rem;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .connection {
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.35rem 0.55rem;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 0.82rem;
    letter-spacing: 0.015em;
  }

  .connection-dot {
    width: 0.55rem;
    aspect-ratio: 1;
    background: var(--signal-green);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 18%);
  }

  .connection.offline .connection-dot {
    background: var(--amber);
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 18%);
  }

  .app-toolbar {
    position: relative;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 1rem;
  }

  .toolbar-list-name {
    flex: 1;
    min-width: 0;
    margin: 0 0.75rem 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .menu-toggle {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
    place-items: center;
    padding: 0;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--accent);
    background: var(--surface);
    box-shadow: 2px 2px 0 #4b4435;
  }

  .menu-toggle:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .menu-toggle[aria-expanded='true'] {
    border-color: var(--accent);
    color: var(--page-bg);
    background: var(--accent);
  }

  .menu-toggle[aria-expanded='true']:hover {
    background: #e2b96f;
  }

  .menu-icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  .main-nav {
    position: absolute;
    top: calc(100% + 0.45rem);
    right: 0;
    z-index: 25;
    width: min(17rem, calc(100vw - 2rem));
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0.35rem;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    box-shadow: 0 8px 20px rgb(0 0 0 / 35%);
  }

  .main-nav[hidden] {
    display: none;
  }

  .main-nav button {
    flex: none;
    width: 100%;
    min-height: 2.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid transparent;
    border-radius: 1px;
    color: var(--text-muted);
    background: transparent;
    font-family: var(--font-display);
    font-size: 0.92rem;
    font-weight: 650;
    letter-spacing: 0.035em;
    text-transform: uppercase;
    text-align: left;
  }

  .main-nav button.active {
    border-color: var(--accent);
    color: var(--page-bg);
    background: var(--accent);
    box-shadow: 2px 2px 0 #806436;
  }

  .message {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin: 0 0 1rem;
    padding: 0.8rem 1rem;
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface);
    font-size: 0.92rem;
  }

  .error-message {
    border-color: #81564b;
    color: #f0c0b4;
    background: #30231f;
  }

  .success-message {
    border-color: #59684a;
    color: var(--success);
    background: #252b21;
  }

  .cache-warning {
    margin: 0 0 1rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid #75613e;
    border-radius: 2px;
    color: #e8c98e;
    background: #2e291f;
    font-size: 0.85rem;
  }

  .update-banner,
  .offline-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--line-bright);
    border-left: 3px solid var(--accent);
    border-radius: 2px;
    color: #d8d2bf;
    background: #292f2c;
    font-size: 0.88rem;
  }

  .offline-banner {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.2rem;
    border-color: #75613e;
    border-left-color: var(--amber);
    color: #e8c98e;
    background: #2e291f;
  }

  .offline-banner span {
    font-size: 0.82rem;
  }

  .list-screen,
  .secondary-screen {
    display: grid;
    gap: 1.25rem;
  }

  .list-heading {
    gap: 1rem;
  }

  .add-open-button {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
    place-items: center;
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--page-bg);
    background: var(--accent);
    box-shadow: 3px 3px 0 #795c31;
    font-family: var(--font-display);
    font-size: 1.7rem;
    font-weight: 500;
    line-height: 1;
  }

  .add-open-button:hover:not(:disabled) {
    background: #e2b96f;
  }

  .add-open-button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .edit-icon {
    width: 1.2rem;
    height: 1.2rem;
  }

  .group-edit-toggle[aria-pressed='true'] {
    border-color: var(--accent);
    color: var(--page-bg);
    background: var(--accent);
  }

  .group-edit-toggle[aria-pressed='true']:hover:not(:disabled) {
    background: #e2b96f;
  }

  .field {
    display: grid;
    gap: 0.35rem;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 650;
    letter-spacing: 0.025em;
  }

  .field input,
  .field textarea,
  .field select {
    width: 100%;
    min-height: 2.8rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--text);
    background: var(--surface-inset);
    color-scheme: dark;
    font-family: var(--font-ui);
    font-weight: 400;
    letter-spacing: 0;
  }

  .field textarea {
    min-height: 5rem;
    resize: vertical;
  }

  .field input[type='color'] {
    min-height: 2.8rem;
    padding: 0.2rem;
    cursor: pointer;
  }

  .add-card,
  .entry-card,
  .manage-card,
  .history-card {
    border: 1px solid var(--line);
    border-radius: 2px;
    background: var(--surface-raised);
    box-shadow: 0 4px 14px rgb(0 0 0 / 16%);
  }

  .add-card {
    padding: 0.9rem;
  }

  .add-name-row,
  .details-fields,
  .rename-form {
    display: flex;
    align-items: end;
    gap: 0.65rem;
  }

  .grow {
    flex: 1;
    min-width: 0;
  }

  .add-name-row input {
    min-height: 3.1rem;
    font-size: 1.05rem;
  }

  .primary-button,
  .secondary-button,
  .clear-button {
    min-height: 2.8rem;
    padding: 0.65rem 0.95rem;
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--page-bg);
    background: var(--accent);
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .primary-button:hover:not(:disabled),
  .secondary-button:hover:not(:disabled) {
    background: #e2b96f;
  }

  .primary-button:disabled,
  .secondary-button:disabled,
  .clear-button:disabled,
  button:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .item-details {
    margin-top: 0.75rem;
    padding-top: 0.7rem;
    border-top: 1px solid var(--line);
  }

  .item-details summary,
  .entry-note summary {
    min-height: 2.5rem;
    align-content: center;
    color: var(--accent);
    font-family: var(--font-display);
    font-size: 0.88rem;
    font-weight: 650;
    cursor: pointer;
  }

  .details-fields {
    align-items: start;
    flex-wrap: wrap;
    padding: 0.4rem 0 0.5rem;
  }

  .details-fields > .field {
    flex: 1 1 12rem;
  }

  .group-choices {
    min-width: 100%;
    margin: 0;
    padding: 0.4rem 0 0;
    border: 0;
  }

  .group-choices legend {
    padding: 0;
    color: var(--text-muted);
    font-family: var(--font-display);
    font-size: 0.82rem;
    font-weight: 650;
  }

  .choice-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    padding-top: 0.35rem;
  }

  .choice {
    display: flex;
    min-height: 2.75rem;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--line);
    border-radius: 2px;
    color: var(--text);
    background: var(--surface);
  }

  .choice input {
    width: 1.1rem;
    height: 1.1rem;
    accent-color: var(--accent);
  }

  .entry-section {
    display: grid;
    gap: 0.65rem;
  }

  .group-list-section {
    display: grid;
    gap: 0.65rem;
    padding: 0.8rem;
    border: 1px solid var(--line-bright);
    border-left: 4px solid var(--group-color, var(--accent));
    border-radius: 2px;
    background: linear-gradient(115deg, #303633, #272d2a 72%);
    box-shadow: 0 3px 10px rgb(0 0 0 / 18%);
  }

  .group-list-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.05rem 0.1rem 0.55rem;
    border-bottom: 1px solid var(--line);
  }

  .group-heading-title {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
  }

  .group-collapse-toggle {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
    place-items: center;
    padding: 0;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--accent);
    background: var(--surface-inset);
    font-family: var(--font-display);
    font-size: 1.1rem;
    font-weight: 700;
    line-height: 1;
  }

  .group-collapse-toggle:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .group-list-heading h2 {
    flex: 1;
    min-width: 0;
    margin: 0;
    color: var(--text);
    font-family: var(--font-display);
    font-size: 0.98rem;
    font-weight: 700;
    letter-spacing: 0.045em;
    text-transform: uppercase;
    overflow-wrap: anywhere;
  }

  .group-list-heading h2::before {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    margin-right: 0.5rem;
    border: 1px solid var(--line);
    background: var(--group-color, var(--accent));
    content: '';
    vertical-align: 0.06em;
  }

  .group-heading-tools {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.35rem;
  }

  .group-order-controls {
    display: flex;
    gap: 0.2rem;
  }

  .group-order-button {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    min-height: 2.75rem;
    place-items: center;
    padding: 0;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--text-muted);
    background: var(--surface-inset);
    box-shadow: 2px 2px 0 #4b4435;
    font-family: var(--font-display);
    font-size: 1.05rem;
    font-weight: 700;
    line-height: 1;
  }

  .group-order-button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--page-bg);
    background: var(--accent);
  }

  .group-list-heading .count {
    color: var(--signal-green);
    background: var(--surface-inset);
    border-color: var(--group-color, var(--line));
  }

  .group-list-content[hidden] {
    display: none;
  }

  .group-empty {
    padding: 0.75rem;
    border-color: var(--line);
    background: var(--surface-inset);
    font-size: 0.86rem;
  }

  .count {
    display: inline-grid;
    min-width: 1.6rem;
    min-height: 1.6rem;
    place-items: center;
    margin-left: 0.25rem;
    padding: 0 0.35rem;
    border: 1px solid var(--line);
    border-radius: 1px;
    color: var(--accent);
    background: var(--surface);
    font-family: var(--font-display);
    font-size: 0.78rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    vertical-align: 0.08em;
  }

  .entry-list,
  .history-list,
  .manage-list {
    display: grid;
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .entry-card {
    padding: 0.65rem 0.8rem;
    border-color: #454e47;
  }

  .entry-main {
    gap: 0.65rem;
  }

  .purchase-toggle,
  .purchased-check,
  .history-check {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    aspect-ratio: 1;
    place-items: center;
    border: 1px solid var(--line-bright);
    border-radius: 2px;
    color: var(--accent);
    background: var(--surface-inset);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 16%);
    font-size: 1.2rem;
    font-weight: 750;
  }

  .purchase-toggle span {
    opacity: 0;
  }

  .purchase-toggle:hover:not(:disabled) span,
  .purchase-toggle:focus-visible span {
    opacity: 1;
  }

  .purchase-toggle:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .entry-copy {
    flex: 1;
    min-width: 0;
  }

  .entry-title-row {
    flex-wrap: wrap;
    gap: 0.25rem 0.55rem;
    line-height: 1.35;
  }

  .entry-title-row strong,
  .manage-title strong {
    font-size: 1rem;
    font-weight: 700;
    word-break: break-word;
  }

  .quantity {
    color: var(--signal-green);
    font-family: var(--font-display);
    font-size: 0.9rem;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .badge,
  .kind-label {
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--group-color, var(--line-bright));
    border-radius: 1px;
    color: #e0bd7a;
    background: #393326;
    font-family: var(--font-display);
    font-size: 0.74rem;
    font-weight: 650;
    text-transform: uppercase;
  }

  .entry-note {
    margin-top: 0.2rem;
  }

  .entry-note summary {
    min-height: 1.9rem;
    font-size: 0.8rem;
  }

  .entry-note p {
    margin: 0.1rem 0 0.5rem;
    color: var(--text-muted);
    font-size: 0.9rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .entry-actions {
    flex-direction: row;
    align-items: center;
    flex-shrink: 0;
    gap: 0.1rem;
  }

  .entry-actions .quiet-button {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    place-items: center;
    padding: 0;
  }

  .entry-action-icon {
    display: block;
    width: 1.1rem;
    height: 1.1rem;
  }

  .quiet-button,
  .text-button {
    min-height: 2.75rem;
    padding: 0.45rem 0.65rem;
    border: 1px solid transparent;
    border-radius: 1px;
    color: var(--accent);
    background: transparent;
    font-family: var(--font-display);
    font-size: 0.85rem;
    font-weight: 650;
    letter-spacing: 0.015em;
    text-transform: uppercase;
  }

  .quiet-button:hover:not(:disabled),
  .text-button:hover {
    border-color: var(--line-bright);
    background: var(--accent-soft);
  }

  .danger-text {
    color: var(--danger);
  }

  .purchased-section {
    border-top: 1px solid var(--line-bright);
  }

  .purchased-toggle {
    width: 100%;
    min-height: 3.5rem;
    gap: 1rem;
    padding: 0.45rem 0.15rem;
    border: 0;
    color: var(--text);
    background: transparent;
    font-family: var(--font-display);
    text-align: left;
    font-weight: 700;
    letter-spacing: 0.025em;
    text-transform: uppercase;
  }

  .purchased-title {
    gap: 0.45rem;
  }

  .chevron {
    width: 1rem;
    font-size: 1.1rem;
  }

  .clear-label {
    color: var(--danger);
    font-family: var(--font-display);
    font-size: 0.84rem;
    text-transform: uppercase;
  }

  .purchased-content {
    display: grid;
    gap: 0.7rem;
    padding-bottom: 0.5rem;
  }

  .purchased-card {
    display: flex;
    align-items: center;
    gap: 0.7rem;
  }

  .purchased-check,
  .history-check {
    border-color: var(--line-bright);
    color: var(--signal-green);
    background: var(--surface-inset);
  }

  .purchase-store {
    margin: 0.25rem 0 0;
    color: #e0bd7a;
    font-family: var(--font-display);
    font-size: 0.84rem;
    font-weight: 650;
  }

  .muted {
    margin: 0.25rem 0 0;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .clear-button {
    justify-self: start;
    border-color: var(--danger);
    color: var(--danger);
    background: #342521;
  }

  .clear-button:hover:not(:disabled) {
    background: #473028;
  }

  .empty-list {
    margin: 0;
    padding: 1rem;
    border: 1px dashed var(--line-bright);
    border-radius: 2px;
    color: var(--text-muted);
    background: var(--surface-inset);
    text-align: center;
  }

  .empty-state {
    display: grid;
    min-height: 55vh;
    align-content: center;
    justify-items: center;
    gap: 0.75rem;
    padding: 2rem 1rem;
    text-align: center;
  }

  .empty-state h2 {
    margin-top: 0.25rem;
  }

  .empty-state p {
    max-width: 25rem;
    margin-bottom: 0.5rem;
    color: var(--text-muted);
    line-height: 1.55;
  }

  .group-create {
    display: flex;
    align-items: end;
    gap: 0.7rem;
  }

  .group-kind-field {
    width: 10rem;
  }

  .group-color-field {
    width: 6.25rem;
    flex: 0 0 6.25rem;
  }

  .manage-card {
    padding: 0.65rem 0.75rem;
  }

  .manage-title {
    gap: 0.8rem;
  }

  .manage-title > div:first-child {
    display: grid;
    gap: 0.3rem;
  }

  .manage-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .manage-actions .quiet-button {
    display: grid;
    width: 2.75rem;
    min-width: 2.75rem;
    place-items: center;
    padding: 0;
  }

  .group-action-icon {
    display: block;
    width: 1.1rem;
    height: 1.1rem;
  }

  .rename-form {
    align-items: end;
    flex-wrap: wrap;
  }

  .row-actions {
    gap: 0.25rem;
  }

  .edit-form {
    display: grid;
    gap: 0.7rem;
  }

  .history-card {
    gap: 0.75rem;
    padding: 0.75rem;
  }

  .history-card .entry-copy p {
    margin-bottom: 0;
  }

  .secondary-button {
    color: var(--accent);
    background: var(--surface);
  }

  .secondary-button:hover:not(:disabled) {
    color: var(--page-bg);
    background: var(--accent);
  }

  .load-more {
    justify-self: center;
  }

  .device-data {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem 1rem;
    margin-top: 2rem;
    padding-top: 0.8rem;
    border-top: 1px solid var(--line);
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .device-info {
    display: flex;
    flex: 1 1 26rem;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
  }

  .device-info p {
    flex: 1 1 14rem;
    margin: 0;
  }

  .device-info .connection {
    justify-content: flex-start;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (max-width: 620px) {
    .app-shell {
      width: min(100% - 1.2rem, 48rem);
      padding-top: 0.8rem;
    }

    .update-banner,
    .device-data {
      align-items: stretch;
      flex-direction: column;
    }

    .device-info {
      align-items: flex-start;
      flex-direction: column;
    }

    .connection {
      justify-content: flex-start;
    }

    .main-nav button {
      padding-inline: 0.35rem;
      font-size: 0.8rem;
    }

    .secondary-screen > .list-heading {
      align-items: flex-start;
      flex-direction: column;
    }

    .add-name-row,
    .group-create {
      align-items: stretch;
    }

    .add-name-row {
      gap: 0.45rem;
    }

    .add-button {
      padding-inline: 0.7rem;
    }

    .group-create {
      flex-direction: column;
    }

    .group-kind-field {
      width: 100%;
    }

    .entry-card {
      padding: 0.6rem;
    }

    .group-list-section {
      padding: 0.65rem;
    }

    .entry-main {
      align-items: flex-start;
      gap: 0.5rem;
    }

    .purchase-toggle,
    .purchased-check {
      margin-top: 0.1rem;
    }

    .entry-actions {
      flex-direction: row;
      gap: 0.1rem;
    }

    .manage-title {
      align-items: flex-start;
      flex-direction: column;
    }

    .manage-actions {
      justify-content: flex-start;
      margin-inline: -0.35rem;
    }

    .details-fields {
      flex-direction: column;
    }
  }
</style>
