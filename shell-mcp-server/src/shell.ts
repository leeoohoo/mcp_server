import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export interface ShellResult {
  output: string;
  stdout: string;
  stderr: string;
  error: string;
  exitCode: number | null;
  signal: string | null;
  pid: number | null;
  backgroundPids: number[];
  timedOut: boolean;
  truncated: boolean;
}

export interface ShellExecOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export async function executeShell(command: string, options: ShellExecOptions): Promise<ShellResult> {
  const isWindows = os.platform() === 'win32';
  const tempFileName = `shell_pgrep_${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tempFilePath = path.join(os.tmpdir(), tempFileName);

  const wrappedCommand = isWindows
    ? command
    : (() => {
        let cmd = command.trim();
        if (!cmd.endsWith('&')) cmd += ';';
        return `{ ${cmd} }; __code=$?; pgrep -g 0 >${tempFilePath} 2>&1; exit $__code;`;
      })();

  const spawnFile = isWindows ? 'powershell.exe' : 'bash';
  const spawnArgs = isWindows ? ['-NoProfile', '-Command', wrappedCommand] : ['-c', wrappedCommand];

  let output = '';
  let stdoutText = '';
  let stderrText = '';
  let errorText = '';
  let timeout: NodeJS.Timeout | null = null;
  let timedOut = false;
  let truncated = false;
  let totalBytes = 0;
  let lastStream: 'stdout' | 'stderr' | null = null;

  const appendOutput = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (truncated) return;
    const remaining = options.maxOutputBytes - totalBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    const text = slice.toString('utf8');
    output += text;
    if (stream === 'stdout') {
      stdoutText += text;
    } else {
      stderrText += text;
    }
    totalBytes += slice.length;
    lastStream = stream;
    if (slice.length < chunk.length) {
      truncated = true;
    }
  };

  const child = spawn(spawnFile, spawnArgs, { cwd: options.cwd, env: process.env });

  const resetTimeout = () => {
    if (options.timeoutMs <= 0) return;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
    }, options.timeoutMs);
  };

  resetTimeout();

  child.stdout.on('data', (chunk: Buffer) => {
    resetTimeout();
    appendOutput(chunk, 'stdout');
  });

  child.stderr.on('data', (chunk: Buffer) => {
    resetTimeout();
    appendOutput(chunk, 'stderr');
  });

  const result: ShellResult = await new Promise((resolve) => {
    child.on('error', (err) => {
      errorText = err.message;
    });
    child.on('close', (code, signal) => {
      resolve({
        output: output || '(empty)',
        stdout: stdoutText || '(empty)',
        stderr: stderrText || '(empty)',
        error: errorText || '(none)',
        exitCode: code,
        signal: signal ?? null,
        pid: child.pid ?? null,
        backgroundPids: [],
        timedOut,
        truncated,
      });
    });
  });

  if (timedOut && result.error === '(none)') {
    result.error = `Command was cancelled after ${options.timeoutMs}ms of inactivity.`;
  }

  if (truncated) {
    result.output += '\n[output truncated]';
    if (lastStream === 'stderr') {
      result.stderr += '\n[output truncated]';
    } else {
      result.stdout += '\n[output truncated]';
    }
  }

  if (!isWindows && fs.existsSync(tempFilePath)) {
    const lines = fs.readFileSync(tempFilePath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (/^\d+$/.test(line)) {
        const pid = Number(line);
        if (pid !== result.pid) result.backgroundPids.push(pid);
      }
    }
    fs.unlinkSync(tempFilePath);
  }

  if (timeout) clearTimeout(timeout);
  return result;
}
