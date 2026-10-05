import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('rejects cross-origin mutations and unexpected Host headers', async ({
  request,
}) => {
  const snapshotResponse = await request.get('/api/snapshot');
  const snapshot = await snapshotResponse.json();
  const origin = new URL(snapshotResponse.url()).origin;
  const unchanged = await request.get('/api/snapshot', {
    headers: { 'if-none-match': snapshotResponse.headers()['etag'] },
  });
  expect(unchanged.status()).toBe(304);
  expect(unchanged.headers()['cache-control']).toBe('no-store');

  const crossOrigin = await request.post('/api/groups', {
    headers: {
      origin: 'https://untrusted.example',
      'content-type': 'application/json',
    },
    data: {
      serverInstanceId: snapshot.serverInstanceId,
      name: 'Rejected group',
      kind: 'category',
    },
  });

  expect(crossOrigin.status()).toBe(403);
  expect(await crossOrigin.json()).toMatchObject({
    error: { code: 'ORIGIN_REJECTED' },
  });

  const staleInstance = await request.post('/api/groups', {
    headers: { origin, 'content-type': 'application/json' },
    data: {
      serverInstanceId: randomUUID(),
      name: 'Stale instance group',
      kind: 'category',
    },
  });
  expect(staleInstance.status()).toBe(409);
  expect(await staleInstance.json()).toMatchObject({
    error: { code: 'SERVER_CHANGED' },
  });

  const unexpectedHost = await request.get('/api/snapshot', {
    headers: { host: 'untrusted.example' },
  });
  expect(unexpectedHost.status()).toBe(400);

  const current = await request.get('/api/snapshot');
  const currentGroups = (await current.json()).groups;
  expect(
    currentGroups.map((group: { name: string }) => group.name),
  ).not.toContain('Rejected group');
  expect(
    currentGroups.map((group: { name: string }) => group.name),
  ).not.toContain('Stale instance group');
});
