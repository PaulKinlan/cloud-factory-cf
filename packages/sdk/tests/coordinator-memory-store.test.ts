import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorMemoryStore, type MemoryFetcher } from '../src/index.ts';

test('CoordinatorMemoryStore: get, set, delete, and list with org and repo scope', async () => {
  const memoryDB = new Map<string, { value: unknown; metadata?: Record<string, unknown>; updatedAt: string }>();

  const fakeFetcher: MemoryFetcher = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const scope = (url.searchParams.get('scope') ?? 'repo') as 'org' | 'repo';
      const path = url.pathname;

      if (init?.method === 'GET' && path === '/memory') {
        const prefix = `${scope}:`;
        const entries = Array.from(memoryDB.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            key: k.slice(prefix.length),
            value: v.value,
            metadata: v.metadata,
            updatedAt: v.updatedAt,
          }));
        return Response.json({ ok: true, entries, keys: entries.map((e) => e.key) });
      }

      if (init?.method === 'GET' && path.startsWith('/memory/')) {
        const key = decodeURIComponent(path.slice('/memory/'.length));
        const fullKey = `${scope}:${key}`;
        if (!memoryDB.has(fullKey)) {
          return Response.json({ ok: false, error: 'not found' }, { status: 404 });
        }
        const item = memoryDB.get(fullKey)!;
        return Response.json({ ok: true, key, value: item.value, metadata: item.metadata, updatedAt: item.updatedAt });
      }

      if (init?.method === 'PUT' && path.startsWith('/memory/')) {
        const key = decodeURIComponent(path.slice('/memory/'.length));
        const fullKey = `${scope}:${key}`;
        const body = JSON.parse(String(init.body)) as { value: unknown; metadata?: Record<string, unknown> };
        memoryDB.set(fullKey, {
          value: body.value,
          metadata: body.metadata,
          updatedAt: new Date().toISOString(),
        });
        return Response.json({ ok: true, key });
      }

      if (init?.method === 'DELETE' && path.startsWith('/memory/')) {
        const key = decodeURIComponent(path.slice('/memory/'.length));
        const fullKey = `${scope}:${key}`;
        if (!memoryDB.has(fullKey)) {
          return Response.json({ ok: false, error: 'not found' }, { status: 404 });
        }
        memoryDB.delete(fullKey);
        return Response.json({ ok: true, key, deleted: true });
      }

      return new Response('not found', { status: 404 });
    },
  };

  const store = new CoordinatorMemoryStore(fakeFetcher);

  // Set repo memory
  await store.set('repo', 'feature_flag', { enabled: true });
  // Set org memory
  await store.set('org', 'company_policy', { max_runs: 100 }, { tier: 'enterprise' });

  // Verify get
  const repoVal = await store.get('repo', 'feature_flag');
  assert.deepEqual(repoVal, { enabled: true });

  const orgVal = await store.get('org', 'company_policy');
  assert.deepEqual(orgVal, { max_runs: 100 });

  // Verify scope isolation
  const crossGet = await store.get('org', 'feature_flag');
  assert.equal(crossGet, undefined);

  // Verify list
  const repoEntries = await store.list('repo');
  assert.equal(repoEntries.length, 1);
  assert.equal(repoEntries[0]!.key, 'feature_flag');
  assert.deepEqual(repoEntries[0]!.value, { enabled: true });

  const orgEntries = await store.list('org');
  assert.equal(orgEntries.length, 1);
  assert.equal(orgEntries[0]!.key, 'company_policy');
  assert.deepEqual(orgEntries[0]!.metadata, { tier: 'enterprise' });

  // Delete
  const deleted = await store.delete('repo', 'feature_flag');
  assert.equal(deleted, true);
  const afterDelete = await store.get('repo', 'feature_flag');
  assert.equal(afterDelete, undefined);
  const remainingRepo = await store.list('repo');
  assert.deepEqual(remainingRepo, []);
});
