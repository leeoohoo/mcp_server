import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { executeShell } from './shell.js';
import { formatBytes, getCommandRoot, isSubpath, resolveWithinRoot } from './utils.js';

export interface ShellServerOptions {
  serverName: string;
  workspaceRoot: string;
  defaultTimeoutMs: number;
  maxOutputBytes: number;
  allowCommands: string[];
  denyCommands: string[];
}

export function createShellServer(options: ShellServerOptions) {
  const {
    serverName,
    workspaceRoot,
    defaultTimeoutMs,
    maxOutputBytes,
    allowCommands,
    denyCommands,
  } = options;

  const server = new McpServer({ name: serverName, version: '0.1.0' });
  const workspaceNote = `Workspace root: ${workspaceRoot}. Paths must stay inside this directory.`;
  const allowNote = allowCommands.length
    ? `Allowed command roots: ${allowCommands.join(', ')}`
    : 'Allowed command roots: any.';
  const denyNote = denyCommands.length
    ? `Denied command roots: ${denyCommands.join(', ')}`
    : 'Denied command roots: none.';

  server.registerTool(
    'run_shell',
    {
      title: 'Run shell command',
      description: [
        'Execute a shell command and return structured output with stdout/stderr separated.',
        `Max combined output: ${formatBytes(maxOutputBytes)}.`,
        `Default inactivity timeout: ${defaultTimeoutMs} ms.`,
        allowNote,
        denyNote,
        workspaceNote,
      ].join('\n'),
      inputSchema: z.object({
        command: z.string().min(1),
        dir_path: z.string().optional(),
        description: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
        max_output_bytes: z.number().int().positive().optional(),
      }),
    },
    async ({ command, dir_path, timeout_ms, max_output_bytes }) => {
      const commandRoot = getCommandRoot(command);
      if (denyCommands.includes(commandRoot)) {
        throw new Error(`Command root is denied: ${commandRoot}`);
      }
      if (allowCommands.length > 0 && !allowCommands.includes(commandRoot)) {
        throw new Error(`Command root is not in allowlist: ${commandRoot}`);
      }

      const resolvedRoot = path.resolve(workspaceRoot);
      const cwd = dir_path ? resolveWithinRoot(resolvedRoot, dir_path) : resolvedRoot;
      if (!isSubpath(resolvedRoot, cwd)) {
        throw new Error(`dir_path must be within workspace: ${resolvedRoot}`);
      }

      const result = await executeShell(command, {
        cwd,
        timeoutMs: timeout_ms ?? defaultTimeoutMs,
        maxOutputBytes: max_output_bytes ?? maxOutputBytes,
      });

      const payload = {
        command,
        directory: dir_path ?? '(root)',
        output: result.output,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        exit_code: result.exitCode ?? '(none)',
        signal: result.signal ?? '(none)',
        background_pids: result.backgroundPids,
        pgid: result.pid ?? '(none)',
        timed_out: result.timedOut,
        truncated: result.truncated,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    }
  );

  return server;
}
