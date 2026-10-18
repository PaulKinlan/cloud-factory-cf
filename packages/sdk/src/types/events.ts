/**
 * Pi-inspired lifecycle hooks and event definitions for Cloud Factory CF.
 */

import type { AgentContext } from './context.ts';

export interface FactoryEvent<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly source?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface BeforeRunEvent {
  readonly runId: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly tools: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface BeforeRunResult {
  readonly prompt?: string;
  readonly systemPrompt?: string;
  readonly tools?: readonly string[];
  readonly cancel?: boolean;
  readonly cancelReason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AfterRunEvent {
  readonly runId: string;
  readonly prompt: string;
  readonly status: 'success' | 'failure' | 'cancelled';
  readonly output?: string;
  readonly error?: string;
  readonly toolCallsCount: number;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AfterRunResult {
  /**
   * Request an autonomous continuation (similar to Pi's agent_before_settle continue: true).
   */
  readonly continue?: boolean;
  /**
   * Follow-up prompt to run if continue is true.
   */
  readonly nextPrompt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EventHandler<TPayload = unknown> = (
  event: FactoryEvent<TPayload>,
  ctx: AgentContext
) => Promise<void> | void;

export type BeforeRunHandler = (
  event: BeforeRunEvent,
  ctx: AgentContext
) => Promise<BeforeRunResult | void> | BeforeRunResult | void;

export type AfterRunHandler = (
  event: AfterRunEvent,
  ctx: AgentContext
) => Promise<AfterRunResult | void> | AfterRunResult | void;

export type CustomEventHandler<TData = unknown> = (
  data: TData,
  ctx: AgentContext
) => Promise<unknown> | unknown;

export type Unsubscribe = () => void;
