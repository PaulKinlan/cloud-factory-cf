/**
 * Core extension interface and extension lifecycle types for Cloud Factory CF.
 */

import type { EventHandler, BeforeRunHandler, AfterRunHandler, CustomEventHandler, Unsubscribe } from './events.ts';
import type { ToolDefinition } from './tools.ts';
import type { ActionSink } from './sinks.ts';

/**
 * ExtensionAPI is the interface passed to extensions when loaded,
 * providing the core extension hooks: on event, on before_run, registerTool,
 * on after_run, and pluggable ActionSink registration.
 */
export interface ExtensionAPI {
  /**
   * Listen to factory events (webhooks, push events, task alerts, etc.).
   */
  on(event: 'event', handler: EventHandler): Unsubscribe;

  /**
   * Hook into the pre-run phase to inspect/modify prompt, system instructions,
   * active tools, or halt execution before the agent starts.
   */
  on(event: 'before_run', handler: BeforeRunHandler): Unsubscribe;

  /**
   * Hook into the post-run phase to inspect agent output, emit sink actions,
   * or request autonomous continuations.
   */
  on(event: 'after_run', handler: AfterRunHandler): Unsubscribe;

  /**
   * Listen to arbitrary custom domain events.
   */
  on<T = unknown>(event: string, handler: CustomEventHandler<T>): Unsubscribe;

  /**
   * Register an executable tool available to the agent runtime.
   */
  registerTool<
    TParams extends Record<string, unknown> = Record<string, unknown>,
    TResult = unknown,
  >(
    tool: ToolDefinition<TParams, TResult>
  ): void;

  /**
   * Register a pluggable ActionSink (e.g. GitHub PR review, Issue, Beads, Telemetry).
   */
  registerSink(sink: ActionSink): void;
}

/**
 * An extension is a function (or default export) receiving ExtensionAPI.
 */
export type Extension = (api: ExtensionAPI) => void | Promise<void>;

export interface ExtensionMetadata {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
}

export interface RegisteredExtension {
  readonly metadata: ExtensionMetadata;
  readonly extension: Extension;
}
