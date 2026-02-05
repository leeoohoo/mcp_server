import { spawn, ChildProcess } from 'child_process';
import { CommandSpec, McpServerConfig } from './types.js';
import { parseCommand } from './utils.js';

export interface RunContext {
  task: string;
  agentId: string | null;
  commandId: string | null;
  skills: string[];
  sessionId: string;
  runId: string;
  category?: string;
  query?: string;
  model?: string;
  callerModel?: string;
  mcpAllowPrefixes?: string[];
  mcpServers?: McpServerConfig[];
}

export interface RunOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error: string | null;
  timedOut: boolean;
}

export interface CommandRun {
  child: ChildProcess;
  startedAt: string;
  result: Promise<RunResult>;
}

export function spawnCommand(spec: CommandSpec, context: RunContext, options: RunOptions = {}): CommandRun {
  const exec = resolveExec(spec.exec);
  if (exec.length === 0 || !exec[0]) {
    throw new Error('Command spec is missing exec');
  }
  const [command, ...args] = exec;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes, 1024 * 1024);

  const mcpServers = Array.isArray(context.mcpServers) ? context.mcpServers : [];
  const env: Record<string, string> = {
    ...process.env,
    ...spec.env,
    SUBAGENT_TASK: context.task,
    SUBAGENT_AGENT_ID: context.agentId || '',
    SUBAGENT_COMMAND_ID: context.commandId || '',
    SUBAGENT_SKILLS: context.skills.join(','),
    SUBAGENT_SESSION_ID: context.sessionId,
    SUBAGENT_RUN_ID: context.runId,
    SUBAGENT_CATEGORY: context.category || '',
    SUBAGENT_QUERY: context.query || '',
    SUBAGENT_MODEL: context.model || '',
    SUBAGENT_CALLER_MODEL: context.callerModel || '',
    SUBAGENT_MCP_ALLOW_PREFIXES: Array.isArray(context.mcpAllowPrefixes) ? context.mcpAllowPrefixes.join(',') : '',
    SUBAGENT_MCP_SERVERS: mcpServers.length > 0 ? JSON.stringify(mcpServers.map(summarizeMcpServer)) : '',
  };

  const startedAt = new Date().toISOString();
  const child = spawn(command, args, {
    cwd: spec.cwd || process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;

  const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8');
    if (target === 'stdout') {
      if (stdout.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stdout.length, 0);
        if (remaining > 0) stdout += text.slice(0, remaining);
        stdoutTruncated = true;
        return;
      }
      stdout += text;
    } else {
      if (stderr.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stderr.length, 0);
        if (remaining > 0) stderr += text.slice(0, remaining);
        stderrTruncated = true;
        return;
      }
      stderr += text;
    }
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
  }

  const result = new Promise<RunResult>((resolve) => {
    let errorMessage: string | null = null;
    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      errorMessage = err?.message || 'spawn error';
    });

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - Date.parse(startedAt);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : null,
        signal: (signal as NodeJS.Signals | null) || null,
        startedAt,
        finishedAt,
        durationMs,
        stdoutTruncated,
        stderrTruncated,
        error: errorMessage,
        timedOut,
      });
    });
  });

  return { child, startedAt, result };
}

function resolveExec(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter(Boolean);
  }
  if (typeof value === 'string') {
    const parsed = parseCommand(value);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry)).filter(Boolean);
    }
  }
  return [];
}

function normalizeMaxOutputBytes(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num <= 0) return Number.POSITIVE_INFINITY;
  return num;
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

export async function runCommandWithInput(
  command: string[],
  input: string,
  env: Record<string, string>,
  options: RunOptions = {}
): Promise<RunResult> {
  if (!Array.isArray(command) || command.length === 0 || !command[0]) {
    throw new Error('Command is required');
  }
  const [cmd, ...args] = command;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes, 1024 * 1024);
  const startedAt = new Date().toISOString();
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let errorMessage: string | null = null;

  const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8');
    if (target === 'stdout') {
      if (stdout.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stdout.length, 0);
        if (remaining > 0) stdout += text.slice(0, remaining);
        stdoutTruncated = true;
        return;
      }
      stdout += text;
    } else {
      if (stderr.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stderr.length, 0);
        if (remaining > 0) stderr += text.slice(0, remaining);
        stderrTruncated = true;
        return;
      }
      stderr += text;
    }
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
  }

  const result = new Promise<RunResult>((resolve) => {
    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      errorMessage = err?.message || 'spawn error';
    });

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - Date.parse(startedAt);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : null,
        signal: (signal as NodeJS.Signals | null) || null,
        startedAt,
        finishedAt,
        durationMs,
        stdoutTruncated,
        stderrTruncated,
        error: errorMessage,
        timedOut,
      });
    });
  });

  if (child.stdin) {
    child.stdin.write(input || '');
    child.stdin.end();
  }

  return await result;
}

export function spawnCommandWithInput(
  command: string[],
  input: string,
  env: Record<string, string>,
  options: RunOptions = {}
): CommandRun {
  if (!Array.isArray(command) || command.length === 0 || !command[0]) {
    throw new Error('Command is required');
  }
  const [cmd, ...args] = command;
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 120000;
  const maxOutputBytes = normalizeMaxOutputBytes(options.maxOutputBytes, 1024 * 1024);
  const startedAt = new Date().toISOString();
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let errorMessage: string | null = null;

  const append = (chunk: Buffer, target: 'stdout' | 'stderr') => {
    const text = chunk.toString('utf8');
    if (target === 'stdout') {
      if (stdout.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stdout.length, 0);
        if (remaining > 0) stdout += text.slice(0, remaining);
        stdoutTruncated = true;
        return;
      }
      stdout += text;
    } else {
      if (stderr.length + text.length > maxOutputBytes) {
        const remaining = Math.max(maxOutputBytes - stderr.length, 0);
        if (remaining > 0) stderr += text.slice(0, remaining);
        stderrTruncated = true;
        return;
      }
      stderr += text;
    }
  };

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
  }

  const result = new Promise<RunResult>((resolve) => {
    let timeout: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      errorMessage = err?.message || 'spawn error';
    });

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout);
      const finishedAt = new Date().toISOString();
      const durationMs = Date.now() - Date.parse(startedAt);
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === 'number' ? code : null,
        signal: (signal as NodeJS.Signals | null) || null,
        startedAt,
        finishedAt,
        durationMs,
        stdoutTruncated,
        stderrTruncated,
        error: errorMessage,
        timedOut,
      });
    });
  });

  if (child.stdin) {
    child.stdin.write(input || '');
    child.stdin.end();
  }

  return { child, startedAt, result };
}
