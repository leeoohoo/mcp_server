import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { runAiWithToolsResponses, runOpenAiResponses } from './ai-responses.js';
import { RunResult, runCommandWithInput } from './runner.js';

export interface AiConfig {
  timeoutMs: number;
  maxOutputBytes: number;
  maxRetries?: number;
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
  responsesEnabled?: boolean;
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

export interface AiEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type AiEventHandler = (event: AiEvent) => void;

export async function runAi(
  config: AiConfig,
  input: AiRunInput,
  options: { signal?: AbortSignal; onEvent?: AiEventHandler } = {}
): Promise<RunResult> {
  const mode = config.command && config.command.length > 0 ? 'command' : 'http';
  logAiRequest(config, input, mode);
  emitEvent(options.onEvent, 'ai_request', buildRequestEventPayload(config, input, mode));
  let result: RunResult | null = null;
  const maxOutputBytes = normalizeMaxOutputBytes(config.maxOutputBytes);
  const maxRetries = normalizeMaxRetries(config.maxRetries);
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
      emitEvent(options.onEvent, 'ai_response', buildResponseEventPayload(result, mode));
      return result;
    }
    if (!config.http || !config.http.apiKey || !config.http.model) {
      throw new Error('AI command is not configured');
    }
    if (config.http.responsesEnabled) {
      result = await runOpenAiResponses(config.http, input, config.timeoutMs, maxOutputBytes, options.signal, {
        onEvent: options.onEvent,
        maxRetries,
      });
    } else {
      result = await runOpenAiSdk(config.http, input, config.timeoutMs, maxOutputBytes, options.signal, {
        onEvent: options.onEvent,
        maxRetries,
      });
    }
    logAiResponse(result, mode);
    emitEvent(options.onEvent, 'ai_response', buildResponseEventPayload(result, mode));
    return result;
  } catch (err) {
    logAiError(err, mode);
    emitEvent(options.onEvent, 'ai_error', buildErrorEventPayload(err, mode));
    throw err;
  }
}

export async function runAiWithTools(
  config: AiConfig,
  input: AiRunInput,
  options: AiToolingOptions,
  runOptions: { signal?: AbortSignal; onEvent?: AiEventHandler } = {}
): Promise<RunResult> {
  if (config.command && config.command.length > 0) {
    throw new Error('AI tool calling is not supported in command mode');
  }
  if (!config.http || !config.http.apiKey || !config.http.model) {
    throw new Error('AI command is not configured');
  }
  if (config.http.responsesEnabled) {
    return await runAiWithToolsResponses(config, input, options, runOptions);
  }

  const startedAt = new Date().toISOString();
  const maxOutputBytes = normalizeMaxOutputBytes(config.maxOutputBytes);
  const maxRetries = normalizeMaxRetries(config.maxRetries);
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
      emitEvent(
        runOptions.onEvent,
        'ai_request',
        buildToolRequestEventPayload(config, baseURL, messages, openAiTools, turn + 1)
      );
      const request = applyReasoningSettings(config.http, {
        model: config.http.model,
        messages: messages as any,
        tools: openAiTools.length > 0 ? (openAiTools as any) : undefined,
        tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
        stream: false,
      });
      const response = await requestWithRetry(
        () => client.chat.completions.create(request as any, { signal: controller.signal }),
        {
          maxRetries,
          shouldRetry: (err) => shouldRetryAiError(err, controller.signal.aborted),
          onRetry: (attempt, delayMs, err) => {
            emitEvent(runOptions.onEvent, 'ai_retry', {
              step: turn + 1,
              attempt,
              delay_ms: delayMs,
              ...summarizeRetryError(err),
            });
          },
        }
      );

      const choice = response?.choices?.[0];
      const message = choice?.message as any;
      logAiToolResponse(message, turn + 1);
      emitEvent(
        runOptions.onEvent,
        'ai_response',
        buildToolResponseEventPayload(message, turn + 1)
      );

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
        emitEvent(runOptions.onEvent, 'tool_call', {
          step: turn + 1,
          tool: toolName,
          arguments: parseError ? toolArgsRaw : toolArgs,
          parse_error: parseError,
        });
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
        emitEvent(runOptions.onEvent, 'tool_result', {
          step: turn + 1,
          tool: toolName,
          result: truncateValue(toolResult),
        });

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
  signal?: AbortSignal,
  options: { onEvent?: AiEventHandler; maxRetries?: number } = {}
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
  const maxRetries = normalizeMaxRetries(options.maxRetries);
  let lastError: unknown = null;
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
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      let attemptStdout = '';
      let attemptTruncated = false;
      abortedForTruncation = false;
      try {
        const stream = (await client.chat.completions.create(request as any, {
          signal: controller.signal,
        })) as unknown as AsyncIterable<any>;
        for await (const chunk of stream) {
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (!delta) continue;
          attemptStdout += delta;
          if (attemptStdout.length > maxOutputBytes) {
            attemptStdout = attemptStdout.slice(0, maxOutputBytes);
            attemptTruncated = true;
            abortedForTruncation = true;
            controller.abort();
            break;
          }
        }
        if (!attemptStdout && !abortedForTruncation) {
          attemptStdout = '';
        }
        stdout = attemptStdout;
        stdoutTruncated = attemptTruncated;
        break;
      } catch (err) {
        lastError = err;
        if (abortedForTruncation) {
          stdout = attemptStdout;
          stdoutTruncated = true;
          break;
        }
        if (
          attempt < maxRetries &&
          shouldRetryAiError(err, controller.signal.aborted)
        ) {
          const delayMs = computeRetryDelayMs(attempt);
          emitEvent(options.onEvent, 'ai_retry', {
            attempt,
            delay_ms: delayMs,
            ...summarizeRetryError(err),
          });
          await sleep(delayMs);
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    if (!abortedForTruncation) {
      if (aborted) {
        error = 'aborted';
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
      if (!error && lastError) {
        error = lastError instanceof Error ? lastError.message : String(lastError);
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
const DEFAULT_AI_MAX_RETRIES = 5;

function normalizeMaxRetries(value: number | undefined): number {
  const num = typeof value === 'number' ? Math.trunc(value) : DEFAULT_AI_MAX_RETRIES;
  if (!Number.isFinite(num) || num < 1) return 1;
  return num;
}

function shouldRetryAiError(err: unknown, aborted: boolean): boolean {
  if (aborted) return false;
  if (!err) return false;
  const name = (err as any)?.name ? String((err as any).name) : '';
  if (name.toLowerCase().includes('abort')) return false;
  const status = getErrorStatus(err);
  if (status) {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  const code = getErrorCode(err);
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  const message = getErrorMessage(err).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return true;
  if (message.includes('rate limit')) return true;
  if (message.includes('econnreset') || message.includes('socket hang up')) return true;
  if (message.includes('enotfound') || message.includes('eai_again')) return true;
  return false;
}

function summarizeRetryError(err: unknown): Record<string, unknown> {
  const status = getErrorStatus(err);
  const code = getErrorCode(err);
  const message = getErrorMessage(err);
  const payload: Record<string, unknown> = { error: message };
  if (status) payload.status = status;
  if (code) payload.code = code;
  return payload;
}

function getErrorStatus(err: unknown): number | null {
  const raw =
    (err as any)?.status ??
    (err as any)?.error?.status ??
    (err as any)?.response?.status ??
    (err as any)?.response?.statusCode ??
    null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return null;
  return num;
}

function getErrorCode(err: unknown): string {
  const raw =
    (err as any)?.code ??
    (err as any)?.error?.code ??
    (err as any)?.response?.data?.error?.code ??
    '';
  return String(raw || '').toUpperCase();
}

function getErrorMessage(err: unknown): string {
  if (!err) return '';
  const msg =
    (err as any)?.message ??
    (err as any)?.error?.message ??
    (err as any)?.response?.data?.error?.message ??
    '';
  return String(msg || err);
}

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT',
  'UND_ERR_SOCKET',
  'UND_ERR_RESPONSE',
]);

function computeRetryDelayMs(attempt: number): number {
  const base = 500;
  const max = 8000;
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = exp * (0.5 + Math.random());
  return Math.round(jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestWithRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    shouldRetry: (err: unknown) => boolean;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  }
): Promise<T> {
  const maxRetries = normalizeMaxRetries(options.maxRetries);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries || !options.shouldRetry(err)) {
        throw err;
      }
      const delayMs = computeRetryDelayMs(attempt);
      if (options.onRetry) options.onRetry(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

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

function emitEvent(handler: AiEventHandler | undefined, type: string, payload: Record<string, unknown>) {
  if (!handler) return;
  try {
    handler({ type, payload });
  } catch {
    // Ignore event handler errors.
  }
}

function buildRequestEventPayload(
  config: AiConfig,
  input: AiRunInput,
  mode: 'command' | 'http'
): Record<string, unknown> {
  if (mode === 'command') {
    return {
      mode,
      timeout_ms: config.timeoutMs,
      max_output_bytes: config.maxOutputBytes,
      max_retries: config.maxRetries,
      command: config.command || [],
      input: sanitizeAiInput(input, { includePrompt: true }),
    };
  }
  const http = config.http || { apiKey: '', baseUrl: '', model: '' };
  return {
    mode,
    timeout_ms: config.timeoutMs,
    max_output_bytes: config.maxOutputBytes,
    max_retries: config.maxRetries,
    model: http.model || '',
    base_url: normalizeBaseUrl(http.baseUrl || ''),
    reasoning_enabled: http.reasoningEnabled,
    responses_enabled: http.responsesEnabled,
    input: sanitizeAiInput(input, { includeMessages: true }),
  };
}

function buildToolRequestEventPayload(
  config: AiConfig,
  baseUrl: string,
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
  step: number
): Record<string, unknown> {
  return {
    mode: 'http',
    step,
    timeout_ms: config.timeoutMs,
    max_output_bytes: config.maxOutputBytes,
    max_retries: config.maxRetries,
    model: config.http?.model || '',
    base_url: baseUrl,
    reasoning_enabled: config.http?.reasoningEnabled,
    responses_enabled: config.http?.responsesEnabled,
    messages: sanitizeMessages(messages),
    tools: sanitizeTools(tools),
  };
}

function buildToolResponseEventPayload(message: Record<string, unknown>, step: number): Record<string, unknown> {
  return {
    mode: 'http',
    step,
    message: sanitizeMessage(message),
  };
}

function buildResponseEventPayload(result: RunResult, mode: 'command' | 'http'): Record<string, unknown> {
  return {
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
  };
}

function buildErrorEventPayload(err: unknown, mode: 'command' | 'http'): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  return { mode, error: message };
}

function logAiRequest(config: AiConfig, input: AiRunInput, mode: 'command' | 'http') {
  if (!isAiLogEnabled()) return;
  const payload: Record<string, unknown> = {
    event: 'subagent_ai_request',
    ts: new Date().toISOString(),
    mode,
    timeout_ms: config.timeoutMs,
    max_output_bytes: config.maxOutputBytes,
    max_retries: config.maxRetries,
  };
  if (mode === 'command') {
    payload.command = config.command || [];
    payload.input = sanitizeAiInput(input, { includePrompt: true });
  } else {
    const http = config.http || { apiKey: '', baseUrl: '', model: '' };
    payload.model = http.model || '';
    payload.base_url = normalizeBaseUrl(http.baseUrl || '');
    payload.reasoning_enabled = http.reasoningEnabled;
    payload.responses_enabled = http.responsesEnabled;
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
      max_retries: config.maxRetries,
      model: config.http?.model || '',
      base_url: baseUrl,
      reasoning_enabled: config.http?.reasoningEnabled,
      responses_enabled: config.http?.responsesEnabled,
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
