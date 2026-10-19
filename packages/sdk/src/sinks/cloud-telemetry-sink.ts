import type {
  ActionSink,
  SinkAction,
  SinkDispatchResult,
  TelemetryMetricPayload,
  TelemetryLogPayload,
} from '../types/sinks.ts';
import type { AgentContext } from '../types/context.ts';

export type TelemetryExporter = (
  entry: { type: 'metric' | 'log'; payload: TelemetryMetricPayload | TelemetryLogPayload; timestamp: number },
  ctx: AgentContext,
) => Promise<Record<string, unknown> | void>;

export interface CloudTelemetrySinkOptions {
  name?: string;
  exporter?: TelemetryExporter;
  bufferInMemory?: boolean;
  maxBufferSize?: number;
}

export class CloudTelemetrySink implements ActionSink {
  readonly name: string;
  readonly supportedActions: readonly string[] = [
    'telemetry:metric',
    'telemetry.metric',
    'telemetry:log',
    'telemetry.log',
  ];
  private readonly customExporter?: TelemetryExporter;
  private readonly buffer: Array<{
    type: 'metric' | 'log';
    payload: TelemetryMetricPayload | TelemetryLogPayload;
    timestamp: number;
  }> = [];
  private readonly bufferInMemory: boolean;
  private readonly maxBufferSize: number;

  constructor(options: CloudTelemetrySinkOptions = {}) {
    this.name = options.name ?? 'cloud-telemetry-sink';
    this.customExporter = options.exporter;
    this.bufferInMemory = options.bufferInMemory ?? true;
    this.maxBufferSize = options.maxBufferSize ?? 1000;
  }

  private pushBuffer(entry: {
    type: 'metric' | 'log';
    payload: TelemetryMetricPayload | TelemetryLogPayload;
    timestamp: number;
  }): void {
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
    }
    this.buffer.push(entry);
  }

  canHandle(action: SinkAction): boolean {
    return this.supportedActions.includes(action.type);
  }

  getBufferedEntries() {
    return [...this.buffer];
  }

  clearBuffer(): void {
    this.buffer.length = 0;
  }

  async handle(action: SinkAction, ctx: AgentContext): Promise<SinkDispatchResult> {
    const start = Date.now();
    const isMetric = action.type.includes('metric');

    if (isMetric) {
      const payload = action.payload as TelemetryMetricPayload;
      if (!payload || typeof payload !== 'object') {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: expected TelemetryMetricPayload object',
          durationMs: Date.now() - start,
        };
      }

      if (typeof payload.metric !== 'string' || payload.metric.trim().length === 0) {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: metric name must be a non-empty string',
          durationMs: Date.now() - start,
        };
      }

      if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: metric value must be a finite number',
          durationMs: Date.now() - start,
        };
      }

      try {
        let result: Record<string, unknown> | undefined;
        if (this.customExporter) {
          const exportResult = await this.customExporter(
            { type: 'metric', payload, timestamp: action.timestamp },
            ctx,
          );
          result = exportResult ?? { exported: true };
        } else if (await ctx.credentials.hasPermission('telemetry', 'emit')) {
          result = await ctx.credentials.executeSignedRequest({
            service: 'telemetry',
            action: 'emit',
            params: { type: 'metric', ...payload },
          });
        } else if (this.bufferInMemory) {
          this.pushBuffer({ type: 'metric', payload, timestamp: action.timestamp });
          result = { buffered: true };
        } else {
          return {
            sinkName: this.name,
            actionId: action.id,
            actionType: action.type,
            success: false,
            error: 'Telemetry dispatch failed: in-memory buffer is disabled and no telemetry exporter or broker permission is available',
            durationMs: Date.now() - start,
          };
        }

        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: true,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: message,
          durationMs: Date.now() - start,
        };
      }
    } else {
      const payload = action.payload as TelemetryLogPayload;
      if (!payload || typeof payload !== 'object') {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: expected TelemetryLogPayload object',
          durationMs: Date.now() - start,
        };
      }

      if (typeof payload.message !== 'string') {
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: 'Invalid payload: log message must be a string',
          durationMs: Date.now() - start,
        };
      }

      try {
        let result: Record<string, unknown> | undefined;
        if (this.customExporter) {
          const exportResult = await this.customExporter(
            { type: 'log', payload, timestamp: action.timestamp },
            ctx,
          );
          result = exportResult ?? { exported: true };
        } else if (await ctx.credentials.hasPermission('telemetry', 'emit')) {
          result = await ctx.credentials.executeSignedRequest({
            service: 'telemetry',
            action: 'emit',
            params: { type: 'log', ...payload },
          });
        } else if (this.bufferInMemory) {
          this.pushBuffer({ type: 'log', payload, timestamp: action.timestamp });
          result = { buffered: true };
        } else {
          return {
            sinkName: this.name,
            actionId: action.id,
            actionType: action.type,
            success: false,
            error: 'Telemetry dispatch failed: in-memory buffer is disabled and no telemetry exporter or broker permission is available',
            durationMs: Date.now() - start,
          };
        }

        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: true,
          result,
          durationMs: Date.now() - start,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          sinkName: this.name,
          actionId: action.id,
          actionType: action.type,
          success: false,
          error: message,
          durationMs: Date.now() - start,
        };
      }
    }
  }
}
