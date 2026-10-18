/**
 * AgentContext implementation and memory/credential defaults.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentContext,
  AgentContextOptions,
  HierarchicalMemoryStore,
  MemoryScope,
  MemoryEntry,
  CredentialBroker,
  CredentialCapabilityRequest,
  LogEntry,
  LogLevel,
} from '../types/context.ts';
import type { ActionSinkDispatcher } from '../types/sinks.ts';
import { ActionSinkRegistry } from '../sinks/sink-registry.ts';

export class InMemoryHierarchicalMemoryStore implements HierarchicalMemoryStore {
  private readonly orgMemory = new Map<string, MemoryEntry>();
  private readonly repoMemory = new Map<string, MemoryEntry>();

  async get(scope: MemoryScope, key: string): Promise<unknown | undefined> {
    const map = scope === 'org' ? this.orgMemory : this.repoMemory;
    return map.get(key)?.value;
  }

  async set(
    scope: MemoryScope,
    key: string,
    value: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const map = scope === 'org' ? this.orgMemory : this.repoMemory;
    map.set(key, {
      key,
      value,
      scope,
      updatedAt: Date.now(),
      metadata,
    });
  }

  async delete(scope: MemoryScope, key: string): Promise<boolean> {
    const map = scope === 'org' ? this.orgMemory : this.repoMemory;
    return map.delete(key);
  }

  async list(scope: MemoryScope, prefix?: string): Promise<MemoryEntry[]> {
    const map = scope === 'org' ? this.orgMemory : this.repoMemory;
    const entries = Array.from(map.values());
    if (!prefix) return entries;
    return entries.filter((e) => e.key.startsWith(prefix));
  }
}

export class DefaultCredentialBroker implements CredentialBroker {
  private readonly allowedCapabilities = new Set<string>();

  constructor(allowed?: readonly string[]) {
    if (allowed) {
      for (const cap of allowed) {
        this.allowedCapabilities.add(cap);
      }
    }
  }

  async hasPermission(service: string, action: string): Promise<boolean> {
    if (this.allowedCapabilities.size === 0) return true;
    return (
      this.allowedCapabilities.has(`${service}:${action}`) ||
      this.allowedCapabilities.has(`${service}:*`) ||
      this.allowedCapabilities.has('*')
    );
  }

  async executeSignedRequest<T = unknown>(request: CredentialCapabilityRequest): Promise<T> {
    const permitted = await this.hasPermission(request.service, request.action);
    if (!permitted) {
      throw new Error(
        `CredentialBroker: permission denied for capability "${request.service}:${request.action}"`
      );
    }
    // Signed capability proxy stub: in production runtime, delegates to cloudflare signed subrequest
    return {
      status: 'brokered',
      service: request.service,
      action: request.action,
      timestamp: Date.now(),
    } as unknown as T;
  }
}

export class AgentContextImpl implements AgentContext {
  readonly id: string;
  readonly sessionId: string;
  readonly repo: AgentContext['repo'];
  readonly org: AgentContext['org'];
  readonly actor: AgentContext['actor'];
  readonly signal: AbortSignal;
  readonly env: Readonly<Record<string, unknown>>;
  readonly memory: HierarchicalMemoryStore;
  readonly sinks: ActionSinkDispatcher;
  readonly credentials: CredentialBroker;
  readonly state: Record<string, unknown>;

  private readonly logs: LogEntry[];

  constructor(options: AgentContextOptions) {
    this.id = options.id ?? randomUUID();
    this.sessionId = options.sessionId ?? this.id;
    this.repo = options.repo;
    this.org = options.org;
    this.actor = options.actor ?? { type: 'system', id: 'cloud-factory' };
    this.signal = options.signal ?? new AbortController().signal;
    this.env = Object.freeze({ ...(options.env ?? {}) });
    this.memory = options.memory ?? new InMemoryHierarchicalMemoryStore();
    this.sinks = options.sinks ?? new ActionSinkRegistry();
    this.credentials = options.credentials ?? new DefaultCredentialBroker();
    this.state = options.state ?? {};
    this.logs = options.logs ? [...options.logs] : [];
  }

  log(level: LogLevel, message: string, data?: unknown): void {
    this.logs.push({
      timestamp: Date.now(),
      level,
      message,
      data,
    });
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  createChildContext(overrides?: Partial<AgentContextOptions>): AgentContext {
    return new AgentContextImpl({
      id: overrides?.id ?? randomUUID(),
      sessionId: overrides?.sessionId ?? this.sessionId,
      repo: overrides?.repo ?? this.repo,
      org: overrides?.org ?? this.org,
      actor: overrides?.actor ?? this.actor,
      signal: overrides?.signal ?? this.signal,
      env: overrides?.env ? { ...this.env, ...overrides.env } : { ...this.env },
      memory: overrides?.memory ?? this.memory,
      sinks: overrides?.sinks ?? this.sinks,
      credentials: overrides?.credentials ?? this.credentials,
      state: overrides?.state ? { ...this.state, ...overrides.state } : { ...this.state },
      logs: this.logs,
    });
  }
}

export function createAgentContext(options: AgentContextOptions): AgentContext {
  return new AgentContextImpl(options);
}
