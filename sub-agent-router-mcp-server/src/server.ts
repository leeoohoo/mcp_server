import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SubAgentCatalog } from './catalog.js';
import { JobStore } from './job-store.js';
import { ConfigStore } from './config-store.js';
import { AiConfig, runAi, extractJson } from './ai.js';
import { spawnCommand } from './runner.js';
import { normalizeId, parseCommand } from './utils.js';
import { AgentSpec, CommandSpec, SkillSpec, McpServerConfig } from './types.js';
import { ChildProcess } from 'child_process';
import { pickAgent } from './selector.js';

export interface ServerOptions {
  serverName: string;
  catalog: SubAgentCatalog;
  jobStore: JobStore;
  configStore: ConfigStore;
  defaultSessionId: string;
  defaultRunId: string;
  timeoutMs: number;
  maxOutputBytes: number;
  ai: AiConfig;
}

type ToolResult = { content: { type: 'text'; text: string }[] };

const SUBAGENT_GUARDRAIL =
  'Tooling guard: sub-agents cannot call mcp_subagent_router_* or other sub-agent routing tools. Complete the task directly with available project/shell/task tools.';

export function createSubAgentRouterServer(options: ServerOptions) {
  const {
    serverName,
    catalog,
    jobStore,
    configStore,
    defaultSessionId,
    defaultRunId,
    timeoutMs,
    maxOutputBytes,
    ai,
  } = options;

  const inflight = new Map<string, ChildProcess>();
  const cancelled = new Set<string>();
  const server = new McpServer({ name: serverName, version: '0.2.0' });

  server.registerTool(
    'get_sub_agent',
    {
      title: 'Get sub-agent details',
      description: 'Return details by agent_id (description, skills, commands, default command).',
      inputSchema: z.object({ agent_id: z.string().min(1) }),
    },
    async ({ agent_id }) => {
      const agent = catalog.getAgent(agent_id);
      if (!agent) {
        throw new Error(`Sub-agent ${agent_id} not found.`);
      }
      return textResult(withChatos(serverName, 'get_sub_agent', {
        agent: serializeAgent(agent),
        commands: serializeCommands(agent.commands || []),
        default_command: agent.defaultCommand || null,
      }));
    }
  );

  server.registerTool(
    'suggest_sub_agent',
    {
      title: 'Suggest sub-agent',
      description: 'Pick the best sub-agent for a task using optional category/skills/command hints.',
      inputSchema: z.object({
        task: z.string().min(1),
        category: z.string().optional(),
        skills: z.array(z.string()).optional(),
        query: z.string().optional(),
        command_id: z.string().optional(),
      }),
    },
    async ({ task, category, skills, query, command_id }) => {
      const agents = catalog.listAgents();
      if (agents.length === 0) {
        return textResult(withChatos(serverName, 'suggest_sub_agent', {
          agent_id: null,
          reason: 'No sub-agents available. Load marketplace or registry.',
          skills: [],
        }));
      }
      const filtered = filterAgents(agents, { category, skills, query, commandId: command_id });
      const pool = filtered.length > 0 ? filtered : agents;

      let suggestion = null as null | { agentId: string; skills: string[]; reason: string };
      const runtime = resolveRuntimeConfig(configStore, {
        commandTimeoutMs: timeoutMs,
        commandMaxOutputBytes: maxOutputBytes,
        aiTimeoutMs: ai.timeoutMs,
        aiMaxOutputBytes: ai.maxOutputBytes,
      });
      const aiConfig = resolveAiConfig(ai, configStore, runtime);
      if (hasAiConfig(aiConfig)) {
        suggestion = await suggestWithAi({
          ai: aiConfig,
          task,
          agents: pool,
          category,
          skills,
          query,
        });
      }

      if (!suggestion) {
        const picked = pickAgent(pool, {
          task,
          category,
          skills,
          query,
          commandId: command_id,
        });
        if (!picked) {
          return textResult(withChatos(serverName, 'suggest_sub_agent', {
            agent_id: null,
            reason: 'No matching sub-agent. Add one to the registry or marketplace.',
            skills: [],
          }));
        }
        suggestion = {
          agentId: picked.agent.id,
          skills: picked.usedSkills,
          reason: picked.reason,
        };
      }

      const agent = catalog.getAgent(suggestion.agentId);
      const usedSkills = resolveSkillIds(suggestion.skills, agent);
      return textResult(withChatos(serverName, 'suggest_sub_agent', {
        agent_id: suggestion.agentId,
        agent_name: agent?.name || '',
        skills: usedSkills,
        reason: suggestion.reason,
      }));
    }
  );

  server.registerTool(
    'run_sub_agent',
    {
      title: 'Run sub-agent',
      description: 'Select and run a sub-agent for a task (auto-pick or by agent_id).',
      inputSchema: z.object({
        task: z.string().min(1),
        agent_id: z.string().optional(),
        category: z.string().optional(),
        skills: z.array(z.string()).optional(),
        model: z.string().optional(),
        caller_model: z.string().optional(),
        query: z.string().optional(),
        command_id: z.string().optional(),
        mcp_allow_prefixes: z.array(z.string()).optional(),
      }),
    },
    async (input) => {
      const resolved = resolveAgentAndCommand(input, catalog);
      const { agent, command, usedSkills, reason } = resolved;
      if (!command && !agent.systemPromptPath) {
        throw new Error(`Sub-agent ${agent.id} has no runnable prompt or command.`);
      }

      const runtime = resolveRuntimeConfig(configStore, {
        commandTimeoutMs: timeoutMs,
        commandMaxOutputBytes: maxOutputBytes,
        aiTimeoutMs: ai.timeoutMs,
        aiMaxOutputBytes: ai.maxOutputBytes,
      });
      const mcpServers = configStore.listMcpServers().filter((entry) => entry.enabled);
      const allowPrefixes = resolveAllowPrefixes(input.mcp_allow_prefixes, configStore, mcpServers);
      const runContext = {
        task: input.task,
        agentId: agent.id,
        commandId: command?.id || null,
        skills: usedSkills.map((skill) => skill.id),
        sessionId: defaultSessionId,
        runId: defaultRunId,
        category: agent.category,
        query: input.query,
        model: input.model,
        callerModel: input.caller_model,
        mcpAllowPrefixes: allowPrefixes,
        mcpServers,
      };

      if (command?.exec) {
        const run = spawnCommand(command, runContext, {
          timeoutMs: runtime.commandTimeoutMs,
          maxOutputBytes: runtime.commandMaxOutputBytes,
        });
        const result = await run.result;
        const status = result.error || result.timedOut || (result.exitCode ?? 0) !== 0 ? 'error' : 'ok';
        const payload = {
          status,
          agent_id: agent.id,
          agent_name: agent.name,
          command_id: command.id,
          skills: runContext.skills,
          reason,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          signal: result.signal,
          duration_ms: result.durationMs,
          started_at: result.startedAt,
          finished_at: result.finishedAt,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
          error: result.error,
          timed_out: result.timedOut,
        };
        return textResult(withChatos(serverName, 'run_sub_agent', payload, status));
      }

      const aiConfig = resolveAiConfig(ai, configStore, runtime);
      ensureAiConfigured(aiConfig);
      const systemPrompt = buildSystemPrompt(agent, usedSkills, command, catalog, allowPrefixes);
      const prompt = buildPrompt(systemPrompt, input.task);
      const result = await runAi(aiConfig, {
        system: systemPrompt,
        user: input.task,
        meta: buildAiMeta(agent, command, runContext),
      });
      const status = result.error || result.timedOut || (result.exitCode ?? 0) !== 0 ? 'error' : 'ok';
      const payload = {
        status,
        agent_id: agent.id,
        agent_name: agent.name,
        command_id: command?.id || null,
        skills: runContext.skills,
        reason,
        response: result.stdout.trim(),
        stderr: result.stderr,
        exit_code: result.exitCode,
        signal: result.signal,
        duration_ms: result.durationMs,
        started_at: result.startedAt,
        finished_at: result.finishedAt,
        stdout_truncated: result.stdoutTruncated,
        stderr_truncated: result.stderrTruncated,
        error: result.error,
        timed_out: result.timedOut,
      };
      return textResult(withChatos(serverName, 'run_sub_agent', payload, status));
    }
  );

  server.registerTool(
    'start_sub_agent_async',
    {
      title: 'Start sub-agent (async)',
      description: 'Start a sub-agent run asynchronously and return a job_id for polling.',
      inputSchema: z.object({
        task: z.string().min(1),
        agent_id: z.string().optional(),
        category: z.string().optional(),
        skills: z.array(z.string()).optional(),
        model: z.string().optional(),
        caller_model: z.string().optional(),
        query: z.string().optional(),
        command_id: z.string().optional(),
        mcp_allow_prefixes: z.array(z.string()).optional(),
      }),
    },
    async (input) => {
      const resolved = resolveAgentAndCommand(input, catalog);
      const { agent, command, usedSkills, reason } = resolved;
      if (!command && !agent.systemPromptPath) {
        throw new Error(`Sub-agent ${agent.id} has no runnable prompt or command.`);
      }
      const job = jobStore.createJob({
        task: input.task,
        agentId: agent.id,
        commandId: command?.id || null,
        payload: input,
      });
      const runtime = resolveRuntimeConfig(configStore, {
        commandTimeoutMs: timeoutMs,
        commandMaxOutputBytes: maxOutputBytes,
        aiTimeoutMs: ai.timeoutMs,
        aiMaxOutputBytes: ai.maxOutputBytes,
      });
      const mcpServers = configStore.listMcpServers().filter((entry) => entry.enabled);
      const allowPrefixes = resolveAllowPrefixes(input.mcp_allow_prefixes, configStore, mcpServers);
      const runContext = {
        task: input.task,
        agentId: agent.id,
        commandId: command?.id || null,
        skills: usedSkills.map((skill) => skill.id),
        sessionId: defaultSessionId,
        runId: defaultRunId,
        category: agent.category,
        query: input.query,
        model: input.model,
        callerModel: input.caller_model,
        mcpAllowPrefixes: allowPrefixes,
        mcpServers,
      };

      let run: ReturnType<typeof spawnCommand> | null = null;
      try {
        if (command?.exec) {
          run = spawnCommand(command, runContext, {
            timeoutMs: runtime.commandTimeoutMs,
            maxOutputBytes: runtime.commandMaxOutputBytes,
          });
        } else {
          const aiConfig = resolveAiConfig(ai, configStore, runtime);
          ensureAiConfigured(aiConfig);
          const systemPrompt = buildSystemPrompt(agent, usedSkills, command, catalog, allowPrefixes);
          const prompt = buildPrompt(systemPrompt, input.task);
          const resultPromise = runAi(aiConfig, {
            system: systemPrompt,
            user: input.task,
            meta: buildAiMeta(agent, command, runContext),
          });
          run = {
            child: createVirtualChild(),
            startedAt: new Date().toISOString(),
            result: resultPromise,
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        jobStore.updateJobStatus(job.id, 'error', null, message);
        jobStore.appendEvent(job.id, 'start_error', { error: message });
        throw err;
      }

      if (run.child) {
        inflight.set(job.id, run.child);
      }
      jobStore.updateJobStatus(job.id, 'running', null, null);
      jobStore.appendEvent(job.id, 'start', { pid: run.child ? run.child.pid : null });
      run.result
        .then((result) => {
          inflight.delete(job.id);
          if (cancelled.has(job.id)) {
            jobStore.appendEvent(job.id, 'finish_ignored', { status: 'cancelled' });
            return;
          }
          const status = result.error || result.timedOut || (result.exitCode ?? 0) !== 0 ? 'error' : 'done';
          const payload = {
            status,
            agent_id: agent.id,
            agent_name: agent.name,
            command_id: command?.id || null,
            skills: runContext.skills,
            reason,
            response: command?.exec ? result.stdout : result.stdout.trim(),
            stderr: result.stderr,
            exit_code: result.exitCode,
            signal: result.signal,
            duration_ms: result.durationMs,
            started_at: result.startedAt,
            finished_at: result.finishedAt,
            stdout_truncated: result.stdoutTruncated,
            stderr_truncated: result.stderrTruncated,
            error: result.error,
            timed_out: result.timedOut,
          };
          jobStore.updateJobStatus(job.id, status, JSON.stringify(payload), result.error);
          jobStore.appendEvent(job.id, 'finish', { status, exit_code: result.exitCode, signal: result.signal });
        })
        .catch((err) => {
          inflight.delete(job.id);
          if (cancelled.has(job.id)) {
            jobStore.appendEvent(job.id, 'finish_ignored', { status: 'cancelled' });
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          jobStore.updateJobStatus(job.id, 'error', null, message);
          jobStore.appendEvent(job.id, 'finish_error', { error: message });
        });

      return textResult(withChatos(serverName, 'start_sub_agent_async', {
        job_id: job.id,
        status: 'running',
        agent_id: agent.id,
        agent_name: agent.name,
        command_id: command?.id || null,
        skills: runContext.skills,
        reason,
      }));
    }
  );

  server.registerTool(
    'get_sub_agent_status',
    {
      title: 'Get async sub-agent status',
      description: 'Poll async sub-agent job status.',
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      const job = jobStore.getJob(job_id);
      if (!job) {
        throw new Error(`Job ${job_id} not found.`);
      }
      if (job.sessionId !== defaultSessionId) {
        throw new Error(`Job ${job_id} does not belong to current session.`);
      }
      const result = parseJson(job.resultJson);
      return textResult(withChatos(serverName, 'get_sub_agent_status', {
        job_id: job.id,
        status: job.status,
        agent_id: job.agentId,
        command_id: job.commandId,
        result,
        error: job.error,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      }));
    }
  );

  server.registerTool(
    'cancel_sub_agent_job',
    {
      title: 'Cancel async sub-agent job',
      description: 'Cancel a running sub-agent job (best-effort).',
      inputSchema: z.object({ job_id: z.string().min(1) }),
    },
    async ({ job_id }) => {
      const job = jobStore.getJob(job_id);
      if (!job) {
        throw new Error(`Job ${job_id} not found.`);
      }
      if (job.sessionId !== defaultSessionId) {
        throw new Error(`Job ${job_id} does not belong to current session.`);
      }
      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        return textResult(withChatos(serverName, 'cancel_sub_agent_job', {
          job_id: job.id,
          status: job.status,
          cancelled: false,
        }));
      }
      cancelled.add(job.id);
      const proc = inflight.get(job.id);
      if (proc) {
        try {
          proc.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch {}
        }, 2000);
      }
      jobStore.updateJobStatus(job.id, 'cancelled', job.resultJson, job.error);
      jobStore.appendEvent(job.id, 'cancel', { pid: proc?.pid || null });
      inflight.delete(job.id);
      return textResult(withChatos(serverName, 'cancel_sub_agent_job', {
        job_id: job.id,
        status: 'cancelled',
        cancelled: true,
      }));
    }
  );

  return server;
}

function resolveAgentAndCommand(
  input: {
    task: string;
    agent_id?: string;
    category?: string;
    skills?: string[];
    query?: string;
    command_id?: string;
  },
  catalog: SubAgentCatalog
): {
  agent: AgentSpec;
  command: CommandSpec | null;
  usedSkills: SkillSpec[];
  reason: string;
} {
  const requestedId = normalizeId(input.agent_id);
  if (requestedId) {
    const agent = catalog.getAgent(requestedId);
    if (!agent) throw new Error(`Sub-agent ${requestedId} not found.`);
    const command = catalog.resolveCommand(agent, input.command_id);
    const usedSkills = selectSkills(agent, input.skills, catalog);
    return { agent, command, usedSkills, reason: requestedId };
  }
  const picked = pickAgent(catalog.listAgents(), {
    task: input.task,
    category: input.category,
    skills: input.skills,
    query: input.query,
    commandId: input.command_id,
  });
  if (!picked) {
    throw new Error('No matching sub-agent. Add one to the registry or marketplace.');
  }
  const agent = picked.agent;
  const command = catalog.resolveCommand(agent, input.command_id);
  const usedSkills = selectSkills(agent, input.skills, catalog);
  return {
    agent,
    command,
    usedSkills,
    reason: picked.reason,
  };
}

async function suggestWithAi(options: {
  ai: AiConfig;
  task: string;
  agents: AgentSpec[];
  category?: string;
  skills?: string[];
  query?: string;
}): Promise<{ agentId: string; skills: string[]; reason: string } | null> {
  const list = options.agents.map((agent) => formatAgent(agent)).join('\n');
  const prompt = [
    'You are a router that chooses the best sub-agent for a task.',
    'Return JSON only with keys: agent_id, skills, reason.',
    'skills must be an array of skill ids that exist for the chosen agent.',
    '',
    `Task: ${options.task}`,
    options.category ? `Category hint: ${options.category}` : '',
    options.query ? `Query hint: ${options.query}` : '',
    options.skills && options.skills.length > 0 ? `Requested skills: ${options.skills.join(', ')}` : '',
    '',
    'Agents:',
    list,
    '',
    'JSON response:',
  ]
    .filter(Boolean)
    .join('\n');

  const result = await runAi(options.ai, {
    prompt,
    meta: {
      SUBAGENT_REQUEST: 'suggest',
    },
  });
  const parsed = extractJson(result.stdout);
  if (!parsed) return null;
  const agentId = normalizeId(parsed.agent_id as string);
  if (!agentId) return null;
  const skills = Array.isArray(parsed.skills) ? parsed.skills.map((s) => String(s || '').trim()).filter(Boolean) : [];
  const reason = typeof parsed.reason === 'string' ? parsed.reason : 'AI selection';
  return { agentId, skills, reason };
}

function formatAgent(agent: AgentSpec): string {
  const skills = Array.isArray(agent.skills) ? agent.skills.join(', ') : '';
  const commands = Array.isArray(agent.commands)
    ? agent.commands.map((cmd) => cmd.id).filter(Boolean).join(', ')
    : '';
  return `- id: ${agent.id}\n  name: ${agent.name}\n  category: ${agent.category || ''}\n  skills: ${skills}\n  commands: ${commands}\n  description: ${agent.description || ''}`;
}

function filterAgents(
  agents: AgentSpec[],
  options: { category?: string; skills?: string[]; query?: string; commandId?: string }
): AgentSpec[] {
  let filtered = agents.slice();
  if (options.category) {
    const target = options.category.trim().toLowerCase();
    filtered = filtered.filter((agent) => (agent.category || '').toLowerCase() === target);
  }
  if (options.skills && options.skills.length > 0) {
    const desired = options.skills.map((s) => s.toLowerCase());
    filtered = filtered.filter((agent) => {
      const agentSkills = (agent.skills || []).map((s) => s.toLowerCase());
      return desired.some((skill) => agentSkills.includes(skill));
    });
  }
  if (options.commandId) {
    const target = options.commandId.trim().toLowerCase();
    filtered = filtered.filter((agent) =>
      (agent.commands || []).some((cmd) => normalizeId(cmd.id).toLowerCase() === target || normalizeId(cmd.name).toLowerCase() === target)
    );
  }
  if (options.query) {
    const q = options.query.trim().toLowerCase();
    filtered = filtered.filter((agent) =>
      `${agent.id} ${agent.name} ${agent.description || ''}`.toLowerCase().includes(q)
    );
  }
  return filtered;
}

function selectSkills(agent: AgentSpec, inputSkills: string[] | undefined, catalog: SubAgentCatalog): SkillSpec[] {
  const preferred = Array.isArray(inputSkills) && inputSkills.length > 0 ? inputSkills : agent.defaultSkills || agent.skills || [];
  const specs = catalog.resolveSkills(preferred);
  return specs;
}

function resolveSkillIds(skillIds: string[], agent?: AgentSpec | null): string[] {
  if (!agent) return skillIds;
  const available = new Set((agent.skills || []).map((s) => s.toLowerCase()));
  return skillIds.filter((skill) => available.size === 0 || available.has(String(skill || '').toLowerCase()));
}

function buildSystemPrompt(
  agent: AgentSpec,
  skills: SkillSpec[],
  command: CommandSpec | null,
  catalog: SubAgentCatalog,
  allowPrefixes: string[]
): string {
  const sections: string[] = [];
  sections.push(`You are ${agent.name}.`);
  const agentPrompt = catalog.readContent(agent.systemPromptPath);
  if (agentPrompt) sections.push(agentPrompt);
  if (command?.instructionsPath) {
    const commandPrompt = catalog.readContent(command.instructionsPath);
    if (commandPrompt) sections.push(`Command instructions:\n${commandPrompt}`);
  }
  if (skills.length > 0) {
    const skillBlocks = skills
      .map((skill) => {
        const content = catalog.readContent(skill.path);
        return content ? `Skill: ${skill.name}\n${content}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (skillBlocks) sections.push(`Skills:\n${skillBlocks}`);
  }
  if (allowPrefixes.length > 0) {
    sections.push(`Allowed MCP prefixes: ${allowPrefixes.join(', ')}`);
  }
  sections.push(SUBAGENT_GUARDRAIL);
  return sections.filter(Boolean).join('\n\n');
}

function buildPrompt(systemPrompt: string, task: string): string {
  return `SYSTEM:\n${systemPrompt}\n\nUSER:\n${task}\n`;
}

function buildAiMeta(
  agent: AgentSpec,
  command: CommandSpec | null,
  ctx: {
    sessionId?: string;
    runId?: string;
    model?: string;
    callerModel?: string;
    skills?: string[];
    mcpAllowPrefixes?: string[];
    mcpServers?: McpServerConfig[];
  }
) {
  const mcpServers = Array.isArray(ctx.mcpServers) ? ctx.mcpServers : [];
  return {
    SUBAGENT_REQUEST: 'run',
    SUBAGENT_AGENT_ID: agent.id,
    SUBAGENT_COMMAND_ID: command?.id || '',
    SUBAGENT_CATEGORY: agent.category || '',
    SUBAGENT_SESSION_ID: String(ctx.sessionId || ''),
    SUBAGENT_RUN_ID: String(ctx.runId || ''),
    SUBAGENT_MODEL: String(ctx.model || ''),
    SUBAGENT_CALLER_MODEL: String(ctx.callerModel || ''),
    SUBAGENT_SKILLS: Array.isArray(ctx.skills) ? ctx.skills.join(',') : '',
    SUBAGENT_MCP_ALLOW_PREFIXES: Array.isArray(ctx.mcpAllowPrefixes) ? ctx.mcpAllowPrefixes.join(',') : '',
    SUBAGENT_MCP_SERVERS: mcpServers.length > 0 ? JSON.stringify(mcpServers.map(summarizeMcpServer)) : '',
  };
}

function ensureAiConfigured(ai: AiConfig) {
  const hasHttp = !!ai.http && !!ai.http.apiKey && !!ai.http.model;
  const hasCommand = Array.isArray(ai.command) && ai.command.length > 0;
  if (!hasHttp && !hasCommand) {
    throw new Error('AI not configured. Set LLM command or API key/base_url/model.');
  }
}

function hasAiConfig(ai: AiConfig): boolean {
  const hasHttp = !!ai.http && !!ai.http.apiKey && !!ai.http.model;
  const hasCommand = Array.isArray(ai.command) && ai.command.length > 0;
  return hasHttp || hasCommand;
}

function resolveAiConfig(
  ai: AiConfig,
  configStore: ConfigStore,
  runtime?: {
    aiTimeoutMs: number;
    aiMaxOutputBytes: number;
  }
): AiConfig {
  const current = configStore.getModelConfig();
  const baseUrl = current.baseUrl || 'https://api.openai.com/v1';
  const http = current.apiKey && current.model ? { apiKey: current.apiKey, baseUrl, model: current.model } : null;
  const command = parseCommand(process.env.SUBAGENT_LLM_CMD);
  return {
    timeoutMs: runtime?.aiTimeoutMs ?? ai.timeoutMs,
    maxOutputBytes: runtime?.aiMaxOutputBytes ?? ai.maxOutputBytes,
    http,
    command: Array.isArray(command) && command.length > 0 ? command : null,
  };
}

function resolveRuntimeConfig(
  configStore: ConfigStore,
  defaults: {
    commandTimeoutMs: number;
    commandMaxOutputBytes: number;
    aiTimeoutMs: number;
    aiMaxOutputBytes: number;
  }
) {
  const runtime = configStore.getRuntimeConfig();
  return {
    commandTimeoutMs: normalizeRuntimeValue(runtime.commandTimeoutMs, defaults.commandTimeoutMs),
    commandMaxOutputBytes: normalizeRuntimeValue(runtime.commandMaxOutputBytes, defaults.commandMaxOutputBytes),
    aiTimeoutMs: normalizeRuntimeValue(runtime.aiTimeoutMs, defaults.aiTimeoutMs),
    aiMaxOutputBytes: normalizeRuntimeValue(runtime.aiMaxOutputBytes, defaults.aiMaxOutputBytes),
  };
}

function normalizeRuntimeValue(value: number | undefined, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value)) return fallback;
  return value;
}

function resolveAllowPrefixes(
  input: string[] | undefined,
  configStore: ConfigStore,
  mcpServers?: McpServerConfig[]
): string[] {
  if (Array.isArray(input) && input.length > 0) {
    return input.map((p) => String(p || '').trim()).filter(Boolean);
  }
  const manual = configStore.getAllowPrefixes();
  if (manual.length > 0) return manual;
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    const prefixes = mcpServers
      .filter((entry) => entry.enabled)
      .map((entry) => normalizeMcpName(entry.name))
      .filter(Boolean)
      .map((name) => `mcp_${name}_`);
    return Array.from(new Set(prefixes));
  }
  return configStore.getEffectiveAllowPrefixes();
}

function normalizeMcpName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function summarizeMcpServer(server: McpServerConfig) {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    endpoint_url: server.endpointUrl || '',
    headers_json: server.headersJson || '',
  };
}

function serializeAgent(agent: AgentSpec) {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    category: agent.category || '',
    skills: agent.skills || [],
  };
}

function serializeCommands(commands: CommandSpec[]) {
  return commands.map((cmd) => ({
    id: cmd.id,
    name: cmd.name || '',
    description: cmd.description || '',
  }));
}

function withChatos(serverName: string, tool: string, payload: Record<string, unknown>, status: string = 'ok') {
  return {
    ...payload,
    chatos: {
      status,
      server: serverName,
      tool,
    },
  };
}

function textResult(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function createVirtualChild(): ChildProcess {
  const stub = {
    pid: -1,
    killed: false,
    kill: () => {
      stub.killed = true;
      return false;
    },
    on: () => stub,
  };
  return stub as unknown as ChildProcess;
}
