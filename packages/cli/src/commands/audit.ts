import type { CliParsedArgs, CommandContext } from '../types.ts';

export interface AuditQueryOptions {
  url: string;
  owner: string;
  repo: string;
  controlKey?: string;
  deliveryId?: string;
  status?: string;
  limit?: number;
  fetchImpl?: typeof fetch;
}

export interface WireAuditSummary {
  deliveryId: string;
  provider: string;
  event: string;
  action: string | null;
  actor: string | null;
  status: string;
  attempts: number;
  receivedAt: string;
  lastError: string | null;
}

export interface WireEventDetail {
  deliveryId: string;
  provider: string;
  event: string;
  action: string | null;
  repository: string;
  actor: string | null;
  status: string;
  attempts: number;
  receivedAt: string;
  availableAt: string;
  lastError: string | null;
  payload: unknown;
}

export interface WireDeliveryRecord {
  agentId: string;
  status: string;
  attempts: number;
  updatedAt: string;
}

export interface EventAuditResponse {
  ok: boolean;
  repository: string;
  count: number;
  stats: Record<string, number>;
  events: WireAuditSummary[];
}

export interface DeliveryDetailResponse {
  ok: boolean;
  repository: string;
  event: WireEventDetail;
  deliveries: WireDeliveryRecord[];
}

export async function fetchEventAudit(
  options: AuditQueryOptions,
): Promise<{ ok: boolean; status: number; data?: unknown; error?: string }> {
  const { url, owner, repo, controlKey, deliveryId, status, limit, fetchImpl = fetch } = options;
  const baseUrl = url.replace(/\/+$/, '');
  const path = deliveryId
    ? `${baseUrl}/audit/events/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(deliveryId)}`
    : `${baseUrl}/audit/events/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const queryParams = new URLSearchParams();
  if (!deliveryId) {
    if (status) queryParams.set('status', status);
    if (limit) queryParams.set('limit', String(limit));
  }
  const fullUrl = queryParams.toString() ? `${path}?${queryParams.toString()}` : path;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (controlKey) {
    headers['x-factory-control-key'] = controlKey;
  }

  try {
    const res = await fetchImpl(fullUrl, { headers });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const err = (json?.error as string | undefined) ?? `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: err };
    }
    return { ok: true, status: res.status, data: json };
  } catch (err: unknown) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatEventTable(data: EventAuditResponse): string {
  const lines: string[] = [];
  lines.push(`DO Event Audit Log for ${data.repository} (${data.count} event(s))`);

  const statEntries = Object.entries(data.stats ?? {});
  if (statEntries.length > 0) {
    const statsStr = statEntries.map(([s, count]) => `${s}: ${count}`).join(', ');
    lines.push(`Status breakdown: ${statsStr}`);
  }
  lines.push('');

  if (!data.events || data.events.length === 0) {
    lines.push('No events found in audit log.');
    return lines.join('\n');
  }

  const colDelivery = 24;
  const colEvent = 26;
  const colActor = 16;
  const colStatus = 12;
  const colAttempts = 10;

  const header =
    'DELIVERY ID'.padEnd(colDelivery) +
    'EVENT.ACTION'.padEnd(colEvent) +
    'ACTOR'.padEnd(colActor) +
    'STATUS'.padEnd(colStatus) +
    'ATTEMPTS'.padEnd(colAttempts) +
    'RECEIVED AT';
  lines.push(header);
  lines.push('-'.repeat(header.length + 15));

  for (const ev of data.events) {
    const evAction = ev.action ? `${ev.event}.${ev.action}` : ev.event;
    const actor = ev.actor ?? '-';
    const row =
      ev.deliveryId.slice(0, colDelivery - 2).padEnd(colDelivery) +
      evAction.slice(0, colEvent - 2).padEnd(colEvent) +
      actor.slice(0, colActor - 2).padEnd(colActor) +
      ev.status.slice(0, colStatus - 2).padEnd(colStatus) +
      String(ev.attempts).padEnd(colAttempts) +
      ev.receivedAt;
    lines.push(row);
  }

  return lines.join('\n');
}

export function formatDeliveryDetail(data: DeliveryDetailResponse): string {
  const { event, deliveries } = data;
  const lines: string[] = [];
  const actionPart = event.action ? `.${event.action}` : '';
  lines.push(`Event: ${event.deliveryId} (${event.provider} ${event.event}${actionPart})`);
  lines.push(`Repository: ${data.repository}`);
  lines.push(`Status: ${event.status} | Attempts: ${event.attempts} | Actor: ${event.actor ?? '-'}`);
  lines.push(`Received At: ${event.receivedAt}`);
  if (event.lastError) {
    lines.push(`Last Error: ${event.lastError}`);
  }
  lines.push('');

  lines.push(`Agent Deliveries (${deliveries?.length ?? 0}):`);
  if (!deliveries || deliveries.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const d of deliveries) {
      lines.push(`  - ${d.agentId}: ${d.status} (attempts: ${d.attempts}, updated: ${d.updatedAt})`);
    }
  }
  lines.push('');

  lines.push('Payload preview:');
  const payloadStr =
    typeof event.payload === 'object' && event.payload !== null
      ? JSON.stringify(event.payload, null, 2)
      : String(event.payload);
  lines.push(payloadStr);

  return lines.join('\n');
}

export async function handleAuditCommand(
  parsed: CliParsedArgs,
  context: CommandContext,
): Promise<number> {
  const { io } = context;
  const owner = context.owner;
  const name = context.name;

  if (!owner || !name) {
    io.stderr('Error: missing --repo <owner/name> for audit command.');
    return 1;
  }

  const url = parsed.url ?? process.env['FACTORY_WORKER_URL'] ?? 'http://localhost:8787';
  const controlKey = parsed.controlKey ?? process.env['FACTORY_CONTROL_KEY'];

  const result = await fetchEventAudit({
    url,
    owner,
    repo: name,
    controlKey,
    deliveryId: parsed.deliveryId,
    status: parsed.status,
    limit: parsed.limit,
  });

  if (!result.ok) {
    io.stderr(`[factory-cloud audit] Error (${result.status}): ${result.error}`);
    return 1;
  }

  if (parsed.json) {
    io.stdout(JSON.stringify(result.data, null, 2));
    return 0;
  }

  if (parsed.deliveryId) {
    io.stdout(formatDeliveryDetail(result.data as DeliveryDetailResponse));
  } else {
    io.stdout(formatEventTable(result.data as EventAuditResponse));
  }

  return 0;
}
