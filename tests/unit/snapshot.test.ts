import { describe, expect, it, vi } from 'vitest';
import { SnapshotCoordinator } from '../../src/lib/client/snapshot';
import type { Snapshot } from '../../src/lib/shared/schemas';

const listId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const instanceA = '6ba7b811-9dad-41d1-80b4-00c04fd430c8';
const instanceB = '6ba7b812-9dad-41d1-80b4-00c04fd430c8';

function makeSnapshot(serverInstanceId: string, revision: number): Snapshot {
  return {
    schemaVersion: 1,
    list: { id: listId, name: 'Shared shopping list' },
    revision,
    serverInstanceId,
    groups: [],
    catalogItems: [],
    entries: [],
  };
}

function snapshotResponse(snapshot: Snapshot): Response {
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: `"${snapshot.serverInstanceId}:${snapshot.revision}"`,
    },
  });
}

function notModifiedResponse(snapshot: Snapshot): Response {
  return new Response(null, {
    status: 304,
    headers: { etag: `"${snapshot.serverInstanceId}:${snapshot.revision}"` },
  });
}

describe('SnapshotCoordinator', () => {
  it('does not revalidate a 304 below its committed revision floor', async () => {
    const version5 = makeSnapshot(instanceA, 5);
    const version6 = makeSnapshot(instanceA, 6);
    const responses = [
      snapshotResponse(version5),
      notModifiedResponse(version5),
      snapshotResponse(version6),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const coordinator = new SnapshotCoordinator(fetcher);

    await expect(coordinator.refresh(true)).resolves.toBe(true);
    coordinator.requireRevision(instanceA, 6);
    await expect(coordinator.refresh()).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(coordinator.getState().snapshot?.revision).toBe(6);
    expect(coordinator.getState().status).toBe('online');
    expect(coordinator.getState().lastVerifiedAt).not.toBeNull();
  });

  it('accepts a restored lower revision from a new instance and retires old responses', async () => {
    const original = makeSnapshot(instanceA, 99);
    const restored = makeSnapshot(instanceB, 2);
    const responses = [
      snapshotResponse(original),
      snapshotResponse(restored),
      snapshotResponse(original),
      snapshotResponse(restored),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const coordinator = new SnapshotCoordinator(fetcher);

    await coordinator.refresh(true);
    await coordinator.refresh(true);
    await expect(coordinator.refresh(true)).resolves.toBe(true);

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(coordinator.getState().snapshot?.serverInstanceId).toBe(instanceB);
    expect(coordinator.getState().snapshot?.revision).toBe(2);
    expect(coordinator.getState().status).toBe('online');
  });
});
