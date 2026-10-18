/**
 * Tool registry and execution handling for Cloud Factory CF.
 */

import type { AgentContext } from '../types/context.ts';
import type {
  ToolDefinition,
  AgentTool,
  ToolExecutionResult,
  JSONSchemaProperty,
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
    const { required, properties, additionalProperties } = definition.parameters;

    // Check required presence using own properties only (fixes cloud-factory-cf-8p4)
    if (required && Array.isArray(required)) {
      for (const requiredProp of required) {
        if (!Object.prototype.hasOwnProperty.call(params, requiredProp) || params[requiredProp] === undefined) {
          throw new Error(
            `Missing required parameter "${requiredProp}" for tool "${definition.name}"`
          );
        }
      }
    }

    // Check additionalProperties: false
    if (additionalProperties === false && properties) {
      for (const key of Object.keys(params)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(
            `Unexpected parameter "${key}" for tool "${definition.name}" (additionalProperties is false)`
          );
        }
      }
    }

    // Check declared types, enums, items, and nested schemas (fixes cloud-factory-cf-z4f)
    if (properties) {
      for (const [propName, propSchema] of Object.entries(properties)) {
        if (Object.prototype.hasOwnProperty.call(params, propName) && params[propName] !== undefined) {
          this.validateProperty(definition.name, propName, params[propName], propSchema);
        }
      }
    }
  }

  private validateProperty(
    toolName: string,
    propPath: string,
    value: unknown,
    schema: JSONSchemaProperty
  ): void {
    const expectedType = schema.type;
    let isValid = true;

    switch (expectedType) {
      case 'string':
        isValid = typeof value === 'string';
        break;
      case 'number':
        isValid = typeof value === 'number' && !Number.isNaN(value);
        break;
      case 'integer':
        isValid = typeof value === 'number' && Number.isInteger(value);
        break;
      case 'boolean':
        isValid = typeof value === 'boolean';
        break;
      case 'array':
        isValid = Array.isArray(value);
        break;
      case 'object':
        isValid = typeof value === 'object' && value !== null && !Array.isArray(value);
        break;
      case 'null':
        isValid = value === null;
        break;
    }

    if (!isValid) {
      const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      throw new Error(
        `Invalid type for parameter "${propPath}" on tool "${toolName}": expected ${expectedType}, got ${actualType}`
      );
    }

    // Enforce enum if declared
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(value as string | number | boolean)) {
        throw new Error(
          `Invalid value for parameter "${propPath}" on tool "${toolName}": expected one of [${schema.enum.join(', ')}], got ${JSON.stringify(value)}`
        );
      }
    }

    // Enforce items for arrays
    if (expectedType === 'array' && schema.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        this.validateProperty(toolName, `${propPath}[${i}]`, value[i], schema.items);
      }
    }

    // Enforce nested properties for objects
    if (expectedType === 'object' && schema.properties && typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      if (schema.required && Array.isArray(schema.required)) {
        for (const req of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(obj, req) || obj[req] === undefined) {
            throw new Error(
              `Missing required property "${req}" in parameter "${propPath}" on tool "${toolName}"`
            );
          }
        }
      }
      for (const [subKey, subSchema] of Object.entries(schema.properties)) {
        if (Object.prototype.hasOwnProperty.call(obj, subKey) && obj[subKey] !== undefined) {
          this.validateProperty(toolName, `${propPath}.${subKey}`, obj[subKey], subSchema);
        }
      }
    }
  }
}
