import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
  reasoningEnabled?: boolean;
}

export interface AiToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AiToolingOptions {
  tools: AiToolDefinition[];
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<string>;
  maxTurns?: number;
}

export async function runAi(
  config: AiConfig,
  input: AiRunInput,
  options: { signal?: AbortSignal } = {}
): Promise<RunResult> {
  const mode = config.command && config.command.length > 0 ? 'command' : 'http';
  logAiRequest(config, input, mode);
  let result: RunResult | null = null;
  const maxOutputBytes = normalizeMaxOutputBytes(config.maxOutputBytes);
  try {
    if (mode === 'command') {
      const prompt = buildPrompt(input);
      result = await runCommandWithInput(
        config.command || [],
        prompt,
        input.meta ? input.meta : {},
        {
          timeoutMs: config.timeoutMs,
          maxOutputBytes,
          signal: options.signal,
        }
      );
      logAiResponse(result, mode);
      return result;
    }
    if (!config.http || !config.http.apiKey || !config.http.model) {
      throw new Error('AI command is not configured');
    }
    result = await runOpenAiSdk(config.http, input, config.timeoutMs, maxOutputBytes, options.signal);
    logAiResponse(result, mode);
    return result;
  } catch (err) {
    logAiError(err, mode);
    throw err;
  }
}

export async function runAiWithTools(
  config: AiConfig,
  input: AiRunInput,
  options: AiToolingOptions,
  runOptions: { signal?: AbortSignal } = {}
): Promise<RunResult> {
  if (config.command && config.command.length > 0) {
    throw new Error('AI tool calling is not supported in command mode');
  }
  if (!config.http || !config.http.apiKey || !config.http.model) {
    throw new Error('AI command is not configured');
  }

  const startedAt = new Date().toISOString();
  const maxOutputBytes = normalizeMaxOutputBytes(config.maxOutputBytes);
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  let timeout: NodeJS.Timeout | null = null;
  const externalSignal = runOptions.signal;
  if (config.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
  }
  const handleAbort = () => {
    aborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      handleAbort();
    } else {
      externalSignal.addEventListener('abort', handleAbort, { once: true });
    }
  }

  const baseURL = normalizeBaseUrl(config.http.baseUrl);
  const client = new OpenAI({
    apiKey: config.http.apiKey,
    baseURL: baseURL || undefined,
    timeout: resolveClientTimeout(config.timeoutMs),
  });

  const messages: Array<Record<string, unknown>> = buildMessages(input);
  const openAiTools = (options.tools || []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || undefined,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));

  let stdout = '';
  let stderr = '';
  let error: string | null = null;
  let exitCode: number | null = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const maxTurns = options.maxTurns && options.maxTurns > 0 ? options.maxTurns : 100;

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      logAiRequestWithMessages(config, baseURL, messages, openAiTools, turn + 1);
      const request = applyReasoningSettings(config.http, {
        model: config.http.model,
        messages: messages as any,
        tools: openAiTools.length > 0 ? (openAiTools as any) : undefined,
        tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
        stream: false,
      });
      const response = await client.chat.completions.create(request as any, { signal: controller.signal });

      const choice = response?.choices?.[0];
      const message = choice?.message as any;
      logAiToolResponse(message, turn + 1);

      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const content = typeof message?.content === 'string' ? message.content : '';
        stdout += content;
        break;
      }

      messages.push({
        role: 'assistant',
        content: typeof message?.content === 'string' ? message.content : '',
        tool_calls: toolCalls,
        ...(typeof message?.reasoning_content === 'string'
          ? { reasoning_content: message.reasoning_content }
          : {}),
      });

      for (const call of toolCalls) {
        const toolName = String(call?.function?.name || '').trim();
        const toolArgsRaw = String(call?.function?.arguments || '').trim();
        let toolArgs: Record<string, unknown> = {};
        let parseError: string | null = null;
        if (toolArgsRaw) {
          try {
            toolArgs = JSON.parse(toolArgsRaw) as Record<string, unknown>;
          } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
          }
        }
        let toolResult: string;
        if (!toolName) {
          toolResult = JSON.stringify({ ok: false, error: 'Tool call missing name.' });
        } else if (parseError) {
          toolResult = JSON.stringify({
            ok: false,
            error: `Failed to parse tool arguments: ${parseError}`,
            raw_arguments: toolArgsRaw,
          });
        } else {
          toolResult = await options.callTool(toolName, toolArgs);
        }

        messages.push({
          role: 'tool',
          tool_call_id: String(call?.id || ''),
          content: toolResult,
        });
      }
    }

    if (!stdout && !timedOut && !error) {
      const last = messages[messages.length - 1] as { role?: string; content?: string };
      if (last?.role === 'assistant' && typeof last.content === 'string') {
        stdout = last.content;
      }
    }

    if (stdout.length > maxOutputBytes) {
      stdout = stdout.slice(0, maxOutputBytes);
      stdoutTruncated = true;
    }
  } catch (err) {
    if (!timedOut) {
      if (aborted) {
        error = 'aborted';
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
      exitCode = 1;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal) {
      try {
        externalSignal.removeEventListener('abort', handleAbort);
      } catch {}
    }
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
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  let timeout: NodeJS.Timeout | null = null;
  const externalSignal = signal;
  if (timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }
  const handleAbort = () => {
    aborted = true;
    controller.abort(externalSignal?.reason);
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      handleAbort();
    } else {
      externalSignal.addEventListener('abort', handleAbort, { once: true });
    }
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
      timeout: resolveClientTimeout(timeoutMs),
    });
    const messages = buildMessages(input);
    const request = applyReasoningSettings(http, {
      model: http.model,
      messages,
      stream: true,
    });
    const stream = (await client.chat.completions.create(request as any, {
      signal: controller.signal,
    })) as unknown as AsyncIterable<any>;
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
      if (aborted) {
        error = 'aborted';
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
      exitCode = 1;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal) {
      try {
        externalSignal.removeEventListener('abort', handleAbort);
      } catch {}
    }
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

function normalizeMaxOutputBytes(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (value <= 0) return Number.POSITIVE_INFINITY;
  return value;
}

function resolveClientTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return MAX_CLIENT_TIMEOUT_MS;
  if (timeoutMs <= 0) return MAX_CLIENT_TIMEOUT_MS;
  return Math.max(0, Math.trunc(timeoutMs));
}

const MAX_CLIENT_TIMEOUT_MS = 2_147_483_647;

function applyReasoningSettings(http: AiHttpConfig, request: Record<string, unknown>): Record<string, unknown> {
  if (!http) return request;
  const enabled = http.reasoningEnabled;
  if (enabled === undefined) return request;
  if (isMoonshotProvider(http.baseUrl, http.model)) {
    if (enabled) {
      return { ...request, thinking: { type: 'enabled' } };
    }
    return request;
  }
  return request;
}

function isMoonshotProvider(baseUrl: string, model: string): boolean {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('moonshot')) return true;
  const name = String(model || '').toLowerCase();
  return name.includes('kimi');
}

function logAiRequest(config: AiConfig, input: AiRunInput, mode: 'command' | 'http') {
  if (!isAiLogEnabled()) return;
  const payload: Record<string, unknown> = {
    event: 'subagent_ai_request',
    ts: new Date().toISOString(),
    mode,
    timeout_ms: config.timeoutMs,
    max_output_bytes: config.maxOutputBytes,
  };
  if (mode === 'command') {
    payload.command = config.command || [];
    payload.input = sanitizeAiInput(input, { includePrompt: true });
  } else {
    const http = config.http || { apiKey: '', baseUrl: '', model: '' };
    payload.model = http.model || '';
    payload.base_url = normalizeBaseUrl(http.baseUrl || '');
    payload.reasoning_enabled = http.reasoningEnabled;
    payload.input = sanitizeAiInput(input, { includeMessages: true });
  }
  logAi(payload, 'request');
}

function logAiRequestWithMessages(
  config: AiConfig,
  baseUrl: string,
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
  step: number
) {
  if (!isAiLogEnabled()) return;
  logAi(
    {
      event: 'subagent_ai_request',
      ts: new Date().toISOString(),
      mode: 'http',
      step,
      timeout_ms: config.timeoutMs,
      max_output_bytes: config.maxOutputBytes,
      model: config.http?.model || '',
      base_url: baseUrl,
      reasoning_enabled: config.http?.reasoningEnabled,
      messages: sanitizeMessages(messages),
      tools: sanitizeTools(tools),
    },
    'request'
  );
}

function logAiResponse(result: RunResult, mode: 'command' | 'http') {
  if (!isAiLogEnabled()) return;
  logAi(
    {
      event: 'subagent_ai_response',
      ts: new Date().toISOString(),
      mode,
      stdout: truncateValue(result.stdout || ''),
      stderr: truncateValue(result.stderr || ''),
      exit_code: result.exitCode,
      signal: result.signal,
      duration_ms: result.durationMs,
      started_at: result.startedAt,
      finished_at: result.finishedAt,
      stdout_truncated: result.stdoutTruncated,
      stderr_truncated: result.stderrTruncated,
      error: result.error,
      timed_out: result.timedOut,
    },
    'response'
  );
}

function logAiToolResponse(message: Record<string, unknown>, step: number) {
  if (!isAiLogEnabled()) return;
  logAi(
    {
      event: 'subagent_ai_response',
      ts: new Date().toISOString(),
      mode: 'http',
      step,
      message: sanitizeMessage(message),
    },
    'response'
  );
}

function logAiError(err: unknown, mode: 'command' | 'http') {
  if (!isAiLogEnabled()) return;
  const message = err instanceof Error ? err.message : String(err);
  logAi(
    {
      event: 'subagent_ai_error',
      ts: new Date().toISOString(),
      mode,
      error: message,
    },
    'error'
  );
}

function isAiLogEnabled(): boolean {
  const raw = String(process.env.SUBAGENT_LOG_AI || '').trim().toLowerCase();
  if (!raw) return false;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function getAiLogLimit(): number | null {
  const raw = String(process.env.SUBAGENT_LOG_AI_MAX_CHARS || '').trim();
  if (!raw) return 8000;
  const num = Number(raw);
  if (!Number.isFinite(num)) return 8000;
  if (num <= 0) return null;
  return num;
}

function truncateValue(value: string): string {
  const limit = getAiLogLimit();
  if (!limit) return value;
  if (value.length <= limit) return value;
  const remaining = value.length - limit;
  return `${value.slice(0, limit)}... [truncated ${remaining} chars]`;
}

function sanitizeAiInput(
  input: AiRunInput,
  options: { includeMessages?: boolean; includePrompt?: boolean }
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    system: input.system ? truncateValue(input.system) : '',
    user: input.user ? truncateValue(input.user) : '',
    prompt: input.prompt ? truncateValue(input.prompt) : '',
    meta: sanitizeMeta(input.meta),
  };
  if (options.includePrompt) {
    payload.raw_prompt = truncateValue(buildPrompt(input));
  }
  if (options.includeMessages) {
    payload.messages = buildMessages(input).map((msg) => ({
      role: msg.role,
      content: truncateValue(msg.content),
    }));
  }
  return payload;
}

function sanitizeMeta(meta?: Record<string, string>): Record<string, string> | null {
  if (!meta) return null;
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    next[key] = truncateValue(String(value ?? ''));
  }
  return next;
}

function sanitizeMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((msg) => sanitizeMessage(msg));
}

function sanitizeMessage(message: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(message)) {
    if (typeof value === 'string') {
      next[key] = truncateValue(value);
    } else if (Array.isArray(value)) {
      next[key] = value.map((entry) => (typeof entry === 'string' ? truncateValue(entry) : entry));
    } else if (value && typeof value === 'object') {
      try {
        const json = JSON.stringify(value);
        next[key] = JSON.parse(truncateValue(json));
      } catch {
        next[key] = value;
      }
    } else {
      next[key] = value;
    }
  }
  return next;
}

function sanitizeTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => sanitizeMessage(tool));
}

function logAi(payload: Record<string, unknown>, kind: 'request' | 'response' | 'error') {
  try {
    console.error(JSON.stringify(payload, null, 2));
  } catch {
    console.error(payload);
  }
  writeAiLogFile(payload, kind);
}

function resolveLogDir(): string | null {
  const override = String(process.env.SUBAGENT_LOG_AI_DIR || '').trim();
  if (override) return override;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    return path.resolve(path.dirname(currentFile), '..');
  } catch {
    return process.cwd();
  }
}

function writeAiLogFile(payload: Record<string, unknown>, kind: 'request' | 'response' | 'error') {
  const dir = resolveLogDir();
  if (!dir) return;
  const filename =
    kind === 'request' ? 'ai_request.log' : kind === 'response' ? 'ai_response.log' : 'ai_error.log';
  const filePath = path.join(dir, filename);
  try {
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // Ignore log write errors.
  }
}
