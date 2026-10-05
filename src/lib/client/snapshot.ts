import { snapshotSchema, type Snapshot } from '../shared/schemas';

export type SnapshotConnectionStatus =
  'connecting' | 'syncing' | 'online' | 'unavailable';

export interface SnapshotClientState {
  snapshot: Snapshot | null;
  status: SnapshotConnectionStatus;
  lastVerifiedAt: number | null;
  fetching: boolean;
  cachedSnapshot: boolean;
  offline: boolean;
}

type RefreshOutcome = 'accepted' | 'not-modified' | 'stale' | 'failed';

function etagFor(snapshot: Snapshot): string {
  return `"${snapshot.serverInstanceId}:${snapshot.revision}"`;
}

/** Maintains one confirmed snapshot and rejects stale/out-of-order poll results. */
export class SnapshotCoordinator {
  private state: SnapshotClientState = {
    snapshot: null,
    status: 'connecting',
    lastVerifiedAt: null,
    fetching: false,
    cachedSnapshot: false,
    offline: false,
  };
  private etag: string | null = null;
  private inFlight: Promise<RefreshOutcome> | null = null;
  private readonly listeners = new Set<(state: SnapshotClientState) => void>();
  private readonly retiredInstanceIds = new Set<string>();
  private requiredRevisionInstanceId: string | null = null;
  private requiredRevision = 0;
  private forceRequested = 0;
  private forceCompleted = 0;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  getState(): SnapshotClientState {
    return this.state;
  }

  subscribe(listener: (state: SnapshotClientState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Show an unverified offline copy until the server returns an authoritative snapshot. */
  restoreCachedSnapshot(snapshot: Snapshot, lastVerifiedAt: number): void {
    if (this.state.snapshot) return;
    this.etag = null;
    this.requiredRevisionInstanceId = snapshot.serverInstanceId;
    this.requiredRevision = 0;
    this.publish({
      snapshot,
      status: 'syncing',
      lastVerifiedAt,
      cachedSnapshot: true,
      offline: true,
    });
  }

  /** Require a successful snapshot at least as new as this committed write. */
  requireRevision(serverInstanceId: string, revision: number): void {
    if (this.requiredRevisionInstanceId !== serverInstanceId) {
      this.requiredRevisionInstanceId = serverInstanceId;
      this.requiredRevision = 0;
    }
    this.requiredRevision = Math.max(this.requiredRevision, revision);
    const snapshot = this.state.snapshot;
    if (
      !snapshot ||
      snapshot.serverInstanceId !== serverInstanceId ||
      snapshot.revision < this.requiredRevision
    ) {
      this.publish({ status: 'syncing' });
    }
  }

  /**
   * Revalidate the current snapshot. A forced refresh is unconditional, and a
   * request made during another poll waits for it before fetching if necessary.
   */
  async refresh(unconditional = false): Promise<boolean> {
    const targetForce = unconditional
      ? ++this.forceRequested
      : this.forceRequested;
    let staleAttempts = 0;

    while (true) {
      let outcome: RefreshOutcome;
      if (this.inFlight) {
        outcome = await this.inFlight;
      } else {
        const force =
          this.forceCompleted < this.forceRequested ||
          this.state.snapshot === null ||
          this.etag === null;
        const forceAtStart = this.forceRequested;
        const request = this.fetchSnapshot(force).finally(() => {
          if (this.inFlight === request) this.inFlight = null;
        });
        this.inFlight = request;
        this.publish({
          fetching: true,
          status: this.state.snapshot ? this.state.status : 'connecting',
        });
        outcome = await request;
        if (force)
          this.forceCompleted = Math.max(this.forceCompleted, forceAtStart);
        this.publish({ fetching: false });
      }

      if (outcome === 'stale') {
        if (staleAttempts > 0) {
          this.publish({ status: 'unavailable' });
          return false;
        }
        staleAttempts += 1;
        if (this.forceCompleted >= this.forceRequested)
          this.forceRequested += 1;
        continue;
      }

      if (this.forceCompleted < targetForce) continue;
      return outcome === 'accepted' || outcome === 'not-modified';
    }
  }

  private async fetchSnapshot(unconditional: boolean): Promise<RefreshOutcome> {
    const headers = new Headers();
    if (!unconditional && this.state.snapshot && this.etag) {
      headers.set('if-none-match', this.etag);
    }

    let response: Response;
    try {
      response = await this.fetcher('/api/snapshot', {
        cache: 'no-store',
        headers,
      });
    } catch {
      this.publish({ status: 'unavailable', offline: true });
      return 'failed';
    }

    try {
      if (response.status === 304) {
        const snapshot = this.state.snapshot;
        if (
          !snapshot ||
          !this.etag ||
          response.headers.get('etag') !== this.etag ||
          (snapshot.serverInstanceId === this.requiredRevisionInstanceId &&
            snapshot.revision < this.requiredRevision)
        ) {
          return 'stale';
        }
        this.publish({
          status: 'online',
          lastVerifiedAt: Date.now(),
          offline: false,
        });
        return 'not-modified';
      }
      if (!response.ok) {
        this.publish({ status: 'unavailable', offline: false });
        return 'failed';
      }

      const parsed = snapshotSchema.safeParse(await response.json());
      if (!parsed.success) {
        this.publish({ status: 'unavailable', offline: false });
        return 'failed';
      }
      const incoming = parsed.data;
      const responseEtag = response.headers.get('etag');
      if (responseEtag !== etagFor(incoming)) return 'stale';
      if (this.retiredInstanceIds.has(incoming.serverInstanceId))
        return 'stale';

      const current = this.state.snapshot;
      if (current && current.serverInstanceId !== incoming.serverInstanceId) {
        this.retiredInstanceIds.add(current.serverInstanceId);
        if (this.requiredRevisionInstanceId !== incoming.serverInstanceId) {
          this.requiredRevisionInstanceId = incoming.serverInstanceId;
          this.requiredRevision = 0;
        }
      } else if (
        !current &&
        this.requiredRevisionInstanceId !== null &&
        this.requiredRevisionInstanceId !== incoming.serverInstanceId
      ) {
        this.requiredRevisionInstanceId = incoming.serverInstanceId;
        this.requiredRevision = 0;
      }

      if (
        (this.requiredRevisionInstanceId === incoming.serverInstanceId &&
          incoming.revision < this.requiredRevision) ||
        (current?.serverInstanceId === incoming.serverInstanceId &&
          incoming.revision < current.revision)
      ) {
        return 'stale';
      }

      this.requiredRevisionInstanceId ??= incoming.serverInstanceId;
      this.etag = responseEtag;
      this.publish({
        snapshot: incoming,
        status: 'online',
        lastVerifiedAt: Date.now(),
        cachedSnapshot: false,
        offline: false,
      });
      return 'accepted';
    } catch {
      this.publish({ status: 'unavailable', offline: false });
      return 'failed';
    }
  }

  private publish(update: Partial<SnapshotClientState>): void {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener(this.state);
  }
}
