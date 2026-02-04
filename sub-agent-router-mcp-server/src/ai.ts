import OpenAI from 'openai';
import { RunResult, runCommandWithInput } from './runner.js';

export interface AiConfig {
  timeoutMs: number;
  maxOutputBytes: number;
  http?: AiHttpConfig | null;
  command?: string[] | null;
}

export interface AiRunInput {
  prompt?: string;
  system?: string;
  user?: string;
  meta?: Record<string, string>;
}

export interface AiHttpConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export async function runAi(config: AiConfig, input: AiRunInput): Promise<RunResult> {
  if (config.command && config.command.length > 0) {
    const prompt = buildPrompt(input);
    return await runCommandWithInput(
      config.command,
      prompt,
      input.meta ? input.meta : {},
      {
        timeoutMs: config.timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
      }
    );
  }
  if (!config.http || !config.http.apiKey || !config.http.model) {
    throw new Error('AI command is not configured');
  }
  return await runOpenAiSdk(config.http, input, config.timeoutMs, config.maxOutputBytes);
}

export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  const slice = text.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice) as Record<string, unknown>;
    return parsed;
  } catch {
    return null;
  }
}

async function runOpenAiSdk(
  http: AiHttpConfig,
  input: AiRunInput,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | null = null;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  let stdout = '';
  let stderr = '';
  let error: string | null = null;
  let exitCode: number | null = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let abortedForTruncation = false;
  try {
    const baseURL = normalizeBaseUrl(http.baseUrl);
    const client = new OpenAI({
      apiKey: http.apiKey,
      baseURL: baseURL || undefined,
    });
    const messages = buildMessages(input);
    const stream = await client.chat.completions.create(
      {
        model: http.model,
        messages,
        stream: true,
      },
      { signal: controller.signal }
    );
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (!delta) continue;
      stdout += delta;
      if (stdout.length > maxOutputBytes) {
        stdout = stdout.slice(0, maxOutputBytes);
        stdoutTruncated = true;
        abortedForTruncation = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if (!abortedForTruncation) {
      error = err instanceof Error ? err.message : String(err);
      exitCode = 1;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (stdout.length > maxOutputBytes) {
    stdout = stdout.slice(0, maxOutputBytes);
    stdoutTruncated = true;
  }
  if (stderr.length > maxOutputBytes) {
    stderr = stderr.slice(0, maxOutputBytes);
    stderrTruncated = true;
  }
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - Date.parse(startedAt);
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    startedAt,
    finishedAt,
    durationMs,
    stdoutTruncated,
    stderrTruncated,
    error,
    timedOut,
  };
}

function buildMessages(input: AiRunInput): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (input.system) {
    messages.push({ role: 'system', content: input.system });
  }
  if (input.user) {
    messages.push({ role: 'user', content: input.user });
  } else if (input.prompt) {
    messages.push({ role: 'user', content: input.prompt });
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: '' });
  }
  return messages;
}

function buildPrompt(input: AiRunInput): string {
  if (input.prompt) return input.prompt;
  const system = input.system ? `SYSTEM:\n${input.system}\n\n` : '';
  const user = input.user ? `USER:\n${input.user}\n` : '';
  const raw = `${system}${user}`.trim();
  return raw || '';
}

function normalizeBaseUrl(baseUrl: string): string {
  let url = String(baseUrl || '').trim();
  if (!url) return '';
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/v1')) return url;
  return `${url}/v1`;
}
