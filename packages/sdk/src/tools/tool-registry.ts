/**
 * Tool registry and execution handling for Cloud Factory CF.
 */

import type { AgentContext } from '../types/context.ts';
import type {
  ToolDefinition,
  AgentTool,
  ToolExecutionResult,
} from '../types/tools.ts';

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  registerTool<
    TParams extends Record<string, unknown> = Record<string, unknown>,
    TResult = unknown,
  >(definition: ToolDefinition<TParams, TResult>): void {
    if (!definition.name) {
      throw new Error('Tool definition must have a name');
    }
    if (!definition.description) {
      throw new Error(`Tool "${definition.name}" must have a description`);
    }
    if (!definition.parameters || definition.parameters.type !== 'object') {
      throw new Error(`Tool "${definition.name}" must have an object parameter schema`);
    }

    const agentTool: AgentTool<TParams, TResult> = {
      definition,
      execute: async (params: TParams, ctx: AgentContext): Promise<ToolExecutionResult<TResult>> => {
        const start = Date.now();
        try {
          if (ctx.signal.aborted) {
            throw new Error(`Tool execution aborted: ${ctx.signal.reason ?? 'aborted'}`);
          }
          this.validateParameters(definition, params);
          const result = await definition.handler(params, ctx);
          return {
            toolName: definition.name,
            success: true,
            result,
            durationMs: Date.now() - start,
          };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            toolName: definition.name,
            success: false,
            error: errorMsg,
            durationMs: Date.now() - start,
          };
        }
      },
    };

    this.tools.set(definition.name, agentTool as AgentTool);
  }

  getTool(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getTools(): readonly AgentTool[] {
    return Array.from(this.tools.values());
  }

  getToolDefinitions(): readonly ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async executeTool(
    name: string,
    params: Record<string, unknown>,
    ctx: AgentContext
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        toolName: name,
        success: false,
        error: `Tool "${name}" not found in registry`,
        durationMs: 0,
      };
    }
    return tool.execute(params, ctx);
  }

  private validateParameters(
    definition: ToolDefinition,
    params: Record<string, unknown>
  ): void {
    const { required } = definition.parameters;
    if (required && Array.isArray(required)) {
      for (const requiredProp of required) {
        if (!(requiredProp in params) || params[requiredProp] === undefined) {
          throw new Error(
            `Missing required parameter "${requiredProp}" for tool "${definition.name}"`
          );
        }
      }
    }
  }
}
