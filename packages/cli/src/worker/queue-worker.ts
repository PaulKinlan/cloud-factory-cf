import { LocalAgentRunner } from '../runner/local-runner.ts';

export interface WireEvent {
  deliveryId: string;
  provider: string;
  event: string;
  action: string | null;
  repository: string;
  actor: string | null;
  receivedAt: string;
  status: string;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  leaseId: string | null;
}

export type Fetcher = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface QueueWorkerOptions {
  coordinatorUrl: string;
  fetcher?: Fetcher;
  runner?: LocalAgentRunner;
  limit?: number;
  visibilityMs?: number;
  pollIntervalMs?: number;
  eventHandler?: (event: WireEvent, runner: LocalAgentRunner) => Promise<unknown>;
}

export interface BatchProcessResult {
  claimedCount: number;
  successCount: number;
  failCount: number;
}

export class QueueWorker {
  readonly coordinatorUrl: string;
  private readonly fetcher: Fetcher;
  private readonly runner: LocalAgentRunner;
  private readonly limit: number;
  private readonly visibilityMs: number;
  private readonly pollIntervalMs: number;
  private readonly customHandler?: (event: WireEvent, runner: LocalAgentRunner) => Promise<unknown>;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(options: QueueWorkerOptions) {
    this.coordinatorUrl = options.coordinatorUrl.replace(/\/+$/, '');
    this.fetcher = options.fetcher ?? (fetch as Fetcher);
    this.runner = options.runner ?? new LocalAgentRunner();
    this.limit = options.limit ?? 5;
    this.visibilityMs = options.visibilityMs ?? 30000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.customHandler = options.eventHandler;
  }

  async claimEvents(): Promise<{ ok: boolean; claimed: WireEvent[]; leaseUntil?: string; error?: string }> {
    const res = await this.fetcher(`${this.coordinatorUrl}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: this.limit,
        visibilityMs: this.visibilityMs,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, claimed: [], error: `Claim failed (${res.status}): ${text}` };
    }

    const data = (await res.json()) as { ok: boolean; claimed: WireEvent[]; leaseUntil?: string };
    return { ok: true, claimed: data.claimed ?? [], leaseUntil: data.leaseUntil };
  }

  async ackEvents(
    claims: readonly { deliveryId: string; leaseId: string }[],
  ): Promise<{ ok: boolean; acknowledged?: number; error?: string; status?: number }> {
    if (claims.length === 0) return { ok: true, acknowledged: 0 };

    const res = await this.fetcher(`${this.coordinatorUrl}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(body['error'] ?? `Ack failed with status ${res.status}`),
      };
    }

    return { ok: true, acknowledged: Number(body['acknowledged'] ?? claims.length) };
  }

  async failEvents(
    claims: readonly { deliveryId: string; leaseId: string }[],
    error: string,
  ): Promise<{ ok: boolean; failed?: number; error?: string; status?: number }> {
    if (claims.length === 0) return { ok: true, failed: 0 };

    const res = await this.fetcher(`${this.coordinatorUrl}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claims, error }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(body['error'] ?? `Fail failed with status ${res.status}`),
      };
    }

    return { ok: true, failed: Number(body['failed'] ?? claims.length) };
  }

  async processNextBatch(): Promise<BatchProcessResult> {
    const claimRes = await this.claimEvents();
    if (!claimRes.ok || claimRes.claimed.length === 0) {
      return { claimedCount: 0, successCount: 0, failCount: 0 };
    }

    let successCount = 0;
    let failCount = 0;

    for (const event of claimRes.claimed) {
      if (!event.leaseId) {
        // Without leaseId, event cannot be safely completed
        failCount++;
        continue;
      }

      const claim = { deliveryId: event.deliveryId, leaseId: event.leaseId };

      try {
        if (this.customHandler) {
          await this.customHandler(event, this.runner);
        } else {
          // Parse repository owner and name
          const [owner, name] = event.repository.split('/');
          const prompt = `Process event ${event.event}${event.action ? ` (${event.action})` : ''} for ${event.repository} by ${event.actor ?? 'unknown'}`;
          await this.runner.run(prompt, undefined, {
            repo: { owner: owner ?? 'unknown', name: name ?? event.repository },
            actor: { type: 'system', id: event.actor ?? 'unknown' },
          });
        }

        const ackRes = await this.ackEvents([claim]);
        if (ackRes.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.failEvents([claim], errorMsg);
        failCount++;
      }
    }

    return {
      claimedCount: claimRes.claimed.length,
      successCount,
      failCount,
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();

    const activeSignal = signal ?? this.abortController.signal;

    while (this.running && !activeSignal.aborted) {
      try {
        const result = await this.processNextBatch();
        // If no events were claimed, backoff and wait for pollInterval
        if (result.claimedCount === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), this.pollIntervalMs);
            activeSignal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      } catch (err: unknown) {
        // Backoff briefly on error before retrying
        await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
  }
}
