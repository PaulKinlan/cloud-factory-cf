/**
 * Natural language prompt compiler for AgentStudio.
 * Compiles user prompts into structured AgentManifests grounded in control and data plane context.
 */

import type {
  AgentManifest,
  AgentTrigger,
  AgentCapabilityRequest,
  AgentSinkConfig,
  StudioContext,
  AgentSynthesisFn,
} from '../types/studio.ts';

export class PromptToAgentCompiler {
  /**
   * Compiles natural language input into a structured AgentManifest.
   */
  async compile(
    inputPrompt: string,
    context: StudioContext = {},
    customSynthesis?: AgentSynthesisFn
  ): Promise<AgentManifest> {
    const trimmed = inputPrompt.trim();
    if (!trimmed) {
      throw new Error('Prompt cannot be empty');
    }

    let manifestCandidate: Partial<AgentManifest> = {};

    if (customSynthesis) {
      const synthesized = await customSynthesis(trimmed, context);
      manifestCandidate = { ...synthesized };
    } else {
      manifestCandidate = this.heuristicCompile(trimmed, context);
    }

    return this.validateAndFinalizeManifest(trimmed, manifestCandidate, context);
  }

  /**
   * Deterministic heuristic compilation grounded in available context.
   */
  private heuristicCompile(prompt: string, context: StudioContext): Partial<AgentManifest> {
    const lower = prompt.toLowerCase();

    // 1. Generate slug name
    let name = 'custom-agent';
    const nameMatch =
      prompt.match(/(?:called|named)\s+(['"]?)([a-z0-9_-]+)\1/i) ||
      prompt.match(/agent[:\s]+(['"]?)([a-z0-9_-]+)\1/i);
    if (nameMatch?.[2]) {
      name = nameMatch[2].toLowerCase();
    } else if (lower.includes('pr review') || lower.includes('pull request review')) {
      name = 'pr-reviewer';
    } else if (lower.includes('pr triage') || lower.includes('pull request triage')) {
      name = 'pr-triage';
    } else if (lower.includes('issue triage') || lower.includes('issue label')) {
      name = 'issue-triage';
    } else if (lower.includes('security') || lower.includes('vuln')) {
      name = 'security-audit';
    } else if (lower.includes('telemetry') || lower.includes('metric')) {
      name = 'telemetry-reporter';
    }

    // 2. Derive triggers
    const triggers: AgentTrigger[] = [];
    if (lower.includes('pr') || lower.includes('pull request')) {
      triggers.push({ event: 'pull_request.opened' });
      triggers.push({ event: 'pull_request.synchronize' });
    }
    if (lower.includes('issue')) {
      triggers.push({ event: 'issues.opened' });
      triggers.push({ event: 'issues.labeled' });
    }
    if (lower.includes('push') || lower.includes('commit')) {
      triggers.push({ event: 'push' });
    }
    if (triggers.length === 0) {
      triggers.push({ event: 'event' });
    }

    // 3. Derive capabilities from context and keywords
    const capabilities: AgentCapabilityRequest[] = [];
    const availablePerms = context.availablePermissions ?? [];

    const isPermAllowed = (service: string, action: string): boolean => {
      if (availablePerms.length === 0) return true;
      return availablePerms.some((p) => p.service === service && p.action === action);
    };

    if (
      (lower.includes('review') || lower.includes('approve') || lower.includes('comment on pr')) &&
      isPermAllowed('github', 'pr.review')
    ) {
      capabilities.push({ service: 'github', action: 'pr.review' });
    }
    if (
      (lower.includes('comment on issue') || lower.includes('issue comment') || lower.includes('reply to issue')) &&
      isPermAllowed('github', 'issue.comment')
    ) {
      capabilities.push({ service: 'github', action: 'issue.comment' });
    }
    if (
      (lower.includes('read repo') || lower.includes('inspect repo') || lower.includes('fetch repo')) &&
      isPermAllowed('github', 'repo.read')
    ) {
      capabilities.push({ service: 'github', action: 'repo.read' });
    }

    // 4. Match tools
    const tools: string[] = [];
    const availableToolNames = context.availableTools ? context.availableTools.map((t) => t.name) : [];

    const addToolIfAvailable = (toolName: string) => {
      if (availableToolNames.length === 0 || availableToolNames.includes(toolName)) {
        if (!tools.includes(toolName)) {
          tools.push(toolName);
        }
      }
    };

    if (lower.includes('file') || lower.includes('code') || lower.includes('read') || lower.includes('inspect')) {
      addToolIfAvailable('read_file');
      addToolIfAvailable('list_files');
    }
    if (lower.includes('write') || lower.includes('modify') || lower.includes('patch')) {
      addToolIfAvailable('write_file');
    }
    if (lower.includes('exec') || lower.includes('run command') || lower.includes('test') || lower.includes('shell')) {
      addToolIfAvailable('exec_command');
    }

    // 5. Match sinks
    const sinks: AgentSinkConfig[] = [];
    const availableSinkNames = context.availableSinks ?? [];

    const addSinkIfAvailable = (sinkType: string) => {
      if (availableSinkNames.length === 0 || availableSinkNames.includes(sinkType)) {
        if (!sinks.some((s) => s.type === sinkType)) {
          sinks.push({ type: sinkType });
        }
      }
    };

    if (capabilities.some((c) => c.action === 'pr.review' || c.action === 'pr.comment')) {
      addSinkIfAvailable('github-pr-review');
    }
    if (capabilities.some((c) => c.action === 'issue.comment')) {
      addSinkIfAvailable('github-issue');
    }
    if (lower.includes('beads') || lower.includes('task') || lower.includes('todo')) {
      addSinkIfAvailable('beads-task');
    }
    if (lower.includes('telemetry') || lower.includes('metric') || lower.includes('log')) {
      addSinkIfAvailable('cloud-telemetry');
    }

    // 6. Memory scope
    let memoryScope: 'org' | 'repo' | 'both' = 'repo';
    if (lower.includes('org-wide') || lower.includes('across repositories') || lower.includes('global memory')) {
      memoryScope = 'both';
    }

    return {
      name,
      version: '0.1.0',
      description: prompt.slice(0, 140),
      prompt,
      triggers,
      tools,
      capabilities,
      sinks,
      memoryScope,
      lifecycleHooks: {
        beforeRun: true,
        afterRun: true,
      },
    };
  }

  /**
   * Enforces security, permission bounds, and schema integrity on the manifest.
   */
  private validateAndFinalizeManifest(
    originalPrompt: string,
    candidate: Partial<AgentManifest>,
    context: StudioContext
  ): AgentManifest {
    const rawName = candidate.name ?? 'custom-agent';
    const name = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'custom-agent';

    const version = candidate.version ?? '0.1.0';
    const description = candidate.description || originalPrompt.slice(0, 140);
    const prompt = candidate.prompt || originalPrompt;

    const triggers = candidate.triggers && candidate.triggers.length > 0
      ? candidate.triggers
      : [{ event: 'event' }];

    // Validate tools against available tools
    let tools = Array.from(candidate.tools ?? []);
    if (context.availableTools && context.availableTools.length > 0) {
      const allowedToolNames = new Set(context.availableTools.map((t) => t.name));
      const invalidTools = tools.filter((t) => !allowedToolNames.has(t));
      if (invalidTools.length > 0) {
        throw new Error(
          `Agent manifest requests tools that are not available in current context: ${invalidTools.join(', ')}`
        );
      }
    }

    // Validate capabilities against available permissions (fail-closed)
    let capabilities = Array.from(candidate.capabilities ?? []);
    if (context.availablePermissions && context.availablePermissions.length > 0) {
      const isAllowed = (c: AgentCapabilityRequest) =>
        context.availablePermissions!.some(
          (p) => p.service === c.service && p.action === c.action
        );
      const unauthorized = capabilities.filter((c) => !isAllowed(c));
      if (unauthorized.length > 0) {
        const unauthStrings = unauthorized.map((c) => `${c.service}:${c.action}`).join(', ');
        throw new Error(
          `Security violation: prompt requests unauthorized capabilities: ${unauthStrings}`
        );
      }
    }

    // Validate sinks
    let sinks = Array.from(candidate.sinks ?? []);
    if (context.availableSinks && context.availableSinks.length > 0) {
      const allowedSinkNames = new Set(context.availableSinks);
      const invalidSinks = sinks.filter((s) => !allowedSinkNames.has(s.type));
      if (invalidSinks.length > 0) {
        throw new Error(
          `Agent manifest requests sinks that are not registered in current context: ${invalidSinks.map((s) => s.type).join(', ')}`
        );
      }
    }

    const memoryScope = candidate.memoryScope ?? 'repo';

    return {
      name,
      version,
      description,
      prompt,
      triggers,
      tools,
      capabilities,
      sinks,
      memoryScope,
      lifecycleHooks: candidate.lifecycleHooks ?? {
        beforeRun: true,
        afterRun: true,
      },
      metadata: candidate.metadata,
    };
  }
}
