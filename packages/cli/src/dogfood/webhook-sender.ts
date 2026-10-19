import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WebhookSenderOptions {
  url: string;
  owner: string;
  repo: string;
  secret: string;
  event: string;
  payload: string | Record<string, unknown>;
  deliveryId?: string;
  drain?: boolean;
  controlKey?: string;
  io?: {
    stdout: (msg: string) => void;
    stderr: (msg: string) => void;
  };
}

export interface WebhookSenderResult {
  ok: boolean;
  deliveryId: string;
  webhookStatus: number;
  webhookResponse: Record<string, unknown> | string;
  drainReport?: Record<string, unknown>;
  error?: string;
}

export async function sendWebhook(options: WebhookSenderOptions): Promise<WebhookSenderResult> {
  const io = options.io ?? {
    stdout: (msg: string) => console.log(msg),
    stderr: (msg: string) => console.error(msg),
  };

  const deliveryId = options.deliveryId ?? crypto.randomUUID();

  // 1. Resolve payload body
  let rawBody: string;
  if (typeof options.payload === 'string') {
    // Check if it is a file path
    try {
      const resolved = path.resolve(options.payload);
      const stat = await fs.stat(resolved).catch(() => null);
      if (stat && stat.isFile()) {
        rawBody = await fs.readFile(resolved, 'utf8');
      } else {
        rawBody = options.payload;
      }
    } catch {
      rawBody = options.payload;
    }
  } else {
    rawBody = JSON.stringify(options.payload);
  }

  // 2. Compute HMAC SHA-256 signature
  const hmac = crypto.createHmac('sha256', options.secret);
  hmac.update(rawBody);
  const signature = `sha256=${hmac.digest('hex')}`;

  // 3. Post to worker webhook endpoint
  const cleanUrl = options.url.replace(/\/+$/, '');
  const endpoint = `${cleanUrl}/webhooks/github/${options.owner}/${options.repo}`;

  io.stdout(`[dogfood webhook] Dispatching GitHub event '${options.event}' to ${endpoint}...`);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': options.event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature,
        'User-Agent': 'GitHub-Hookshot/dogfood',
      },
      body: rawBody,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    io.stderr(`[dogfood webhook] Network request failed: ${msg}`);
    return {
      ok: false,
      deliveryId,
      webhookStatus: 0,
      webhookResponse: msg,
      error: msg,
    };
  }

  let responseData: Record<string, unknown> | string;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    responseData = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } else {
    responseData = await res.text().catch(() => '');
  }

  if (!res.ok) {
    const errorMsg = `Webhook rejected with status ${res.status}: ${JSON.stringify(responseData)}`;
    io.stderr(`[dogfood webhook] ${errorMsg}`);
    return {
      ok: false,
      deliveryId,
      webhookStatus: res.status,
      webhookResponse: responseData,
      error: errorMsg,
    };
  }

  io.stdout(`[dogfood webhook] Webhook accepted (status ${res.status}): deliveryId=${deliveryId}`);

  // 4. Drain if requested
  let drainReport: Record<string, unknown> | undefined;
  if (options.drain) {
    const drainEndpoint = `${cleanUrl}/runs/${options.owner}/${options.repo}`;
    io.stdout(`[dogfood webhook] Draining queue at ${drainEndpoint}...`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (options.controlKey) {
      headers['Authorization'] = `Bearer ${options.controlKey}`;
    }

    try {
      const drainRes = await fetch(drainEndpoint, {
        method: 'POST',
        headers,
      });

      if (!drainRes.ok) {
        const text = await drainRes.text().catch(() => '');
        const errorMsg = `Drain failed (${drainRes.status}): ${text}`;
        io.stderr(`[dogfood webhook] ${errorMsg}`);
        return {
          ok: false,
          deliveryId,
          webhookStatus: res.status,
          webhookResponse: responseData,
          error: errorMsg,
        };
      } else {
        drainReport = (await drainRes.json().catch(() => ({}))) as Record<string, unknown>;
        io.stdout(`[dogfood webhook] Drain completed: ${JSON.stringify(drainReport)}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = `Drain request failed: ${msg}`;
      io.stderr(`[dogfood webhook] ${errorMsg}`);
      return {
        ok: false,
        deliveryId,
        webhookStatus: res.status,
        webhookResponse: responseData,
        error: errorMsg,
      };
    }
  }

  return {
    ok: true,
    deliveryId,
    webhookStatus: res.status,
    webhookResponse: responseData,
    drainReport,
  };
}
