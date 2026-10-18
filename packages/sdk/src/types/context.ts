/**
 * AgentContext and related core execution types for Cloud Factory CF.
 */

import type { ActionSinkDispatcher } from './sinks.ts';

export type MemoryScope = 'org' | 'repo';

export interface MemoryEntry {
  readonly key: string;
  readonly value: unknown;
  readonly scope: MemoryScope;
  readonly updatedAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HierarchicalMemoryStore {
  get(scope: MemoryScope, key: string): Promise<unknown | undefined>;
  set(scope: MemoryScope, key: string, value: unknown, metadata?: Record<string, unknown>): Promise<void>;
  delete(scope: MemoryScope, key: string): Promise<boolean>;
  list(scope: MemoryScope, prefix?: string): Promise<MemoryEntry[]>;
}

export interface RepoIdentifier {
  readonly owner: string;
  readonly name: string;
  readonly ref?: string;
  readonly defaultBranch?: string;
  readonly commitSha?: string;
}

export interface OrgIdentifier {
  readonly id: string;
  readonly name?: string;
}

export interface ActorIdentifier {
  readonly type: 'user' | 'bot' | 'lane' | 'system';
  readonly id: string;
  readonly name?: string;
}

export interface CredentialCapabilityRequest {
  readonly service: string;
  readonly action: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Exe.dev-style Credential Broker Proxy interface:
 * Zero raw secrets exposed to agent prompts or runtimes;
 * all authenticated calls flow through signed capability proxies.
 */
export interface CredentialBroker {
  executeSignedRequest<T = unknown>(request: CredentialCapabilityRequest): Promise<T>;
  hasPermission(service: string, action: string): Promise<boolean>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * AgentContext provides execution environment, scoping, hierarchical memory,
 * sink dispatch, and capability proxies during agent lifecycle and tool runs.
 */
export interface AgentContext {
  readonly id: string;
  readonly sessionId: string;
  readonly repo: RepoIdentifier;
  readonly org: OrgIdentifier;
  readonly actor: ActorIdentifier;
  readonly signal: AbortSignal;
  readonly env: Readonly<Record<string, unknown>>;
  readonly memory: HierarchicalMemoryStore;
  readonly sinks: ActionSinkDispatcher;
  readonly credentials: CredentialBroker;
  readonly state: Record<string, unknown>;

  log(level: LogLevel, message: string, data?: unknown): void;
  getLogs(): readonly LogEntry[];
  createChildContext(overrides?: Partial<AgentContextOptions>): AgentContext;
}

export interface AgentContextOptions {
  id?: string;
  sessionId?: string;
  repo: RepoIdentifier;
  org: OrgIdentifier;
  actor?: ActorIdentifier;
  signal?: AbortSignal;
  env?: Record<string, unknown>;
  memory?: HierarchicalMemoryStore;
  sinks?: ActionSinkDispatcher;
  credentials?: CredentialBroker;
  state?: Record<string, unknown>;
  logs?: LogEntry[];
}
