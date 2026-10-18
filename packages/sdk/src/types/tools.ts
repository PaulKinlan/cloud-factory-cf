/**
 * Tool definitions and schemas for Cloud Factory CF.
 */

import type { AgentContext } from './context.ts';

export interface JSONSchemaProperty {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JSONSchemaProperty;
  readonly properties?: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: readonly string[];
  readonly default?: unknown;
}

export interface ToolParameterSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JSONSchemaProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ToolDefinition<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  handler(params: TParams, ctx: AgentContext): Promise<TResult> | TResult;
}

export interface AgentTool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  readonly definition: ToolDefinition<TParams, TResult>;
  execute(params: TParams, ctx: AgentContext): Promise<ToolExecutionResult<TResult>>;
}

export interface ToolExecutionResult<TResult = unknown> {
  readonly toolName: string;
  readonly success: boolean;
  readonly result?: TResult;
  readonly error?: string;
  readonly durationMs: number;
}
