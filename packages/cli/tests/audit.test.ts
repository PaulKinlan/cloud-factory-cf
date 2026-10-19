import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, runCli } from '../src/cli.ts';
import {
  fetchEventAudit,
  formatDeliveryDetail,
  formatEventTable,
  handleAuditCommand,
  type EventAuditResponse,
  type DeliveryDetailResponse,
} from '../src/commands/audit.ts';
import type { CliIo, CommandContext } from '../src/types.ts';

describe('audit command args parsing', () => {
  it('parses audit command with positional repo and flags', () => {
    const parsed = parseArgs([
      'audit',
      'acme/widgets',
      '--limit',
      '10',
      '--status',
      'failed',
      '--control-key',
      'secret-key',
      '--json',
    ]);
    assert.equal(parsed.command, 'audit');
    assert.equal(parsed.repo, 'acme/widgets');
    assert.equal(parsed.limit, 10);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.controlKey, 'secret-key');
    assert.equal(parsed.json, true);
  });

  it('parses --delivery / --delivery-id and --key flags', () => {
    const parsed = parseArgs([
      'audit',
      '--repo',
      'acme/widgets',
      '--delivery',
      'deliv-42',
      '--key',
      'my-key',
    ]);
    assert.equal(parsed.command, 'audit');
    assert.equal(parsed.repo, 'acme/widgets');
    assert.equal(parsed.deliveryId, 'deliv-42');
    assert.equal(parsed.controlKey, 'my-key');
  });
});

describe('fetchEventAudit', () => {
  it('builds URL with query parameters and passes control key header', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({ ok: true, repository: 'acme/widgets', count: 1, stats: {}, events: [] }),
        { status: 200 },
      );
    };

    const result = await fetchEventAudit({
      url: 'https://worker.internal',
      owner: 'acme',
      repo: 'widgets',
      controlKey: 'test-key',
      status: 'pending',
      limit: 25,
      fetchImpl: fakeFetch,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.match(capturedUrl, /https:\/\/worker\.internal\/audit\/events\/acme\/widgets\?/);
    assert.match(capturedUrl, /status=pending/);
    assert.match(capturedUrl, /limit=25/);
    assert.equal(capturedHeaders['x-factory-control-key'], 'test-key');
  });

  it('addresses single delivery endpoint when deliveryId is provided', async () => {
    let capturedUrl = '';
    const fakeFetch: typeof fetch = async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          ok: true,
          repository: 'acme/widgets',
          event: { deliveryId: 'd-1', provider: 'github', event: 'push', status: 'processed' },
          deliveries: [],
        }),
        { status: 200 },
      );
    };

    const result = await fetchEventAudit({
      url: 'https://worker.internal/',
      owner: 'acme',
      repo: 'widgets',
      deliveryId: 'deliv-abc',
      fetchImpl: fakeFetch,
    });

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'https://worker.internal/audit/events/acme/widgets/deliv-abc');
  });

  it('handles error response from worker gracefully', async () => {
    const fakeFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ ok: false, error: 'not authorised to read audit logs' }), {
        status: 401,
      });
    };

    const result = await fetchEventAudit({
      url: 'https://worker.internal',
      owner: 'acme',
      repo: 'widgets',
      fetchImpl: fakeFetch,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.match(result.error ?? '', /not authorised/);
  });
});

describe('formatEventTable and formatDeliveryDetail', () => {
  it('formats event table with counts and columns', () => {
    const sample: EventAuditResponse = {
      ok: true,
      repository: 'acme/widgets',
      count: 2,
      stats: { processed: 1, pending: 1 },
      events: [
        {
          deliveryId: 'deliv-001',
          provider: 'github',
          event: 'pull_request',
          action: 'opened',
          actor: 'alice',
          status: 'processed',
          attempts: 1,
          receivedAt: '2026-10-19T10:00:00Z',
          lastError: null,
        },
      ],
    };

    const table = formatEventTable(sample);
    assert.match(table, /DO Event Audit Log for acme\/widgets \(2 event\(s\)\)/);
    assert.match(table, /processed: 1/);
    assert.match(table, /deliv-001/);
    assert.match(table, /pull_request\.opened/);
    assert.match(table, /alice/);
    assert.match(table, /processed/);
  });

  it('formats single event detail with agent deliveries', () => {
    const sample: DeliveryDetailResponse = {
      ok: true,
      repository: 'acme/widgets',
      event: {
        deliveryId: 'deliv-001',
        provider: 'github',
        event: 'issues',
        action: 'labeled',
        repository: 'acme/widgets',
        actor: 'bob',
        status: 'processed',
        attempts: 1,
        receivedAt: '2026-10-19T10:05:00Z',
        availableAt: '2026-10-19T10:05:00Z',
        lastError: null,
        payload: { issue: { number: 42 } },
      },
      deliveries: [
        {
          agentId: 'issue-triage',
          status: 'delivered',
          attempts: 1,
          updatedAt: '2026-10-19T10:05:02Z',
        },
      ],
    };

    const detail = formatDeliveryDetail(sample);
    assert.match(detail, /Event: deliv-001 \(github issues\.labeled\)/);
    assert.match(detail, /issue-triage: delivered/);
    assert.match(detail, /"number": 42/);
  });
});

describe('handleAuditCommand', () => {
  it('fails if repository is missing', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    };
    const ctx: CommandContext = { cwd: process.cwd(), io };

    const code = await handleAuditCommand({ command: 'audit' }, ctx);
    assert.equal(code, 1);
    assert.match(stderr.join('\n'), /missing --repo/);
  });

  it('runs successfully through runCli with mocked global fetch', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          repository: 'acme/widgets',
          count: 0,
          stats: {},
          events: [],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const code = await runCli(['audit', 'acme/widgets', '--json'], io);
      assert.equal(code, 0);
      assert.match(stdout.join('\n'), /"ok": true/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
