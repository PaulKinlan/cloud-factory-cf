/**
 * @factory-cloud/sdk
 *
 * Core SDK types, AgentContext, Pi-inspired lifecycle hooks,
 * and pluggable ActionSink for Cloud Factory CF.
 */

// Core Types
export type {
  AgentContext,
  AgentContextOptions,
  HierarchicalMemoryStore,
  MemoryScope,
  MemoryEntry,
  RepoIdentifier,
  OrgIdentifier,
  ActorIdentifier,
  CredentialBroker,
  CredentialCapabilityRequest,
  LogLevel,
  LogEntry,
} from './types/context.ts';

export type {
  FactoryEvent,
  BeforeRunEvent,
  BeforeRunResult,
  AfterRunEvent,
  AfterRunResult,
  EventHandler,
  BeforeRunHandler,
  AfterRunHandler,
  CustomEventHandler,
  Unsubscribe,
} from './types/events.ts';

export type {
  JSONSchemaProperty,
  ToolParameterSchema,
  ToolDefinition,
  AgentTool,
  ToolExecutionResult,
} from './types/tools.ts';

export type {
  SinkAction,
  SinkActionInput,
  SinkDispatchResult,
  ActionSink,
  ActionSinkDispatcher,
  GitHubPRReviewPayload,
  GitHubIssuePayload,
  BeadsTaskPayload,
  TelemetryMetricPayload,
  TelemetryLogPayload,
} from './types/sinks.ts';

export type {
  Extension,
  ExtensionAPI,
  ExtensionMetadata,
  RegisteredExtension,
} from './types/extension.ts';

// Implementations
export {
  createAgentContext,
  AgentContextImpl,
  InMemoryHierarchicalMemoryStore,
  DefaultCredentialBroker,
} from './context/agent-context.ts';

export {
  ActionSinkRegistry,
  MemoryActionSink,
} from './sinks/sink-registry.ts';

export {
  ToolRegistry,
} from './tools/tool-registry.ts';

export {
  LifecycleEngine,
  type BeforeRunPipelineResult,
  type AfterRunPipelineResult,
} from './lifecycle/lifecycle-engine.ts';

export {
  AgentRuntime,
  type AgentExecutionInput,
  type AgentExecutionOutput,
  type AgentExecutionFn,
  type AgentRunSummary,
} from './runtime/agent-runtime.ts';
