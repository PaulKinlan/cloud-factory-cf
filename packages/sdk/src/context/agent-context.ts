/**
 * AgentContext implementation and memory/credential defaults.
 */

import { generateId } from '../utils/id.ts';
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

export type CredentialExecutor = (
  request: CredentialCapabilityRequest
) => Promise<unknown>;

/**
 * DefaultCredentialBroker: fail-closed by default.
 * Denies all requests unless explicitly allowed, and delegates signed requests
 * to an optional executor (such as a Cloudflare Worker signed capability subrequest).
 */
export class DefaultCredentialBroker implements CredentialBroker {
  private readonly allowedCapabilities = new Set<string>();
  private readonly executor?: CredentialExecutor;

  constructor(allowed?: readonly string[], executor?: CredentialExecutor) {
    if (allowed) {
      for (const cap of allowed) {
        this.allowedCapabilities.add(cap);
      }
    }
    this.executor = executor;
  }

  async hasPermission(service: string, action: string): Promise<boolean> {
    // Fail closed: empty allowlist denies all capabilities
    if (this.allowedCapabilities.size === 0) return false;
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
    if (!this.executor) {
      throw new Error(
        `CredentialBroker: no capability executor configured to perform "${request.service}:${request.action}"`
      );
    }
    const res = await this.executor(request);
    return res as T;
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
    this.id = options.id ?? generateId();
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
    // Share logs array reference so child context logs propagate to parent
    this.logs = options.logs ?? [];
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
      id: overrides?.id ?? generateId(),
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
      logs: this.logs, // Pass shared logs array
    });
  }
}

export function createAgentContext(options: AgentContextOptions): AgentContext {
  return new AgentContextImpl(options);
}
