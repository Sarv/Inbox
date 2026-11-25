/**
 * Multi-turn AI calls with tools, for agents that decide their own next step.
 *
 * Every provider the app supports already speaks one of two wire formats: the
 * OpenAI Chat Completions format (OpenAI, Sarv, custom endpoints) or Gemini's
 * `generateContent`. Tool calls are two more fields in each, so this module
 * encodes them on top of the SAME request code the single-prompt calls use
 * (`postOpenAICompatibleChat` / `postGeminiGenerate`): bearer refresh, redirect
 * refusal, timeout, error classification and usage reporting stay identical.
 */

import { MAX_MESSAGE_BYTES } from '../utils/json-size';

import {
  outputTokenLimit,
  postGeminiGenerate,
  postOpenAICompatibleChat,
  withAIRetry,
  type AIProviderConfig,
} from './categorization-utils';

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool call the model asked for. `arguments` is the raw JSON text it sent. */
export interface AIToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type AIChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  /** `providerParts` carries Gemini's raw parts so a thought signature is echoed back unchanged. */
  | { role: 'assistant'; content: string; toolCalls?: AIToolCall[]; providerParts?: unknown[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AIChatRequest {
  messages: AIChatMessage[];
  tools?: AIToolDefinition[];
  /** Overrides `config.maxOutputTokens` for this call. */
  maxOutputTokens?: number;
  /**
   * `none` turns reasoning off on an OpenAI-compatible endpoint. Some reasoning
   * models (gpt-6-luna) accept tools on Chat Completions only that way. Ignored
   * for Gemini, whose thinking is already off; a provider's own pinned setting
   * (Sarv's) still wins.
   */
  reasoningEffort?: 'none';
  timeoutMs?: number;
}

export interface AIChatResult {
  text: string;
  toolCalls: AIToolCall[];
  /** `length` means the output budget ran out, possibly all of it on reasoning. */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  providerParts?: unknown[];
}

const GEMINI_CALL_PREFIX = 'gemini-call-';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 16_000;

function requestSize(request: AIChatRequest): number {
  let size = 0;
  for (const message of request.messages) {
    size += message.content.length;
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) size += call.arguments.length + call.name.length;
  }
  return size;
}

/**
 * The request body is stringified, and messages can carry text a stranger
 * sized (an email body). Past the limit stringifying ends the app, and no
 * provider would accept it: refused as a 413, terminal and never retried.
 */
function assertRequestSize(request: AIChatRequest): void {
  if (requestSize(request) > MAX_MESSAGE_BYTES) {
    throw Object.assign(new Error('This request is too large to send to the AI provider.'), { status: 413 });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function argumentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '{}';
  return JSON.stringify(value);
}

function openAIMessages(messages: AIChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content || null,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        } : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function openAIFinish(reason: unknown, toolCalls: AIToolCall[]): AIChatResult['finishReason'] {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call' || toolCalls.length) return 'tool_calls';
  if (reason === 'stop' || reason === undefined || reason === null) return 'stop';
  return 'other';
}

async function callOpenAICompatibleChat(config: AIProviderConfig, request: AIChatRequest, signal?: AbortSignal): Promise<AIChatResult> {
  const data = record(await postOpenAICompatibleChat(config, {
    messages: openAIMessages(request.messages),
    max_completion_tokens: outputTokenLimit({ ...config, maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens }),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      tool_choice: 'auto',
    } : {}),
  }, signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const choice = record(Array.isArray(data?.choices) ? data.choices[0] : undefined);
  const message = record(choice?.message);
  const toolCalls: AIToolCall[] = [];
  if (Array.isArray(message?.tool_calls)) {
    for (const [index, item] of message.tool_calls.entries()) {
      const call = record(item);
      const fn = record(call?.function);
      if (!fn || typeof fn.name !== 'string' || !fn.name) continue;
      toolCalls.push({ id: typeof call?.id === 'string' && call.id ? call.id : `call-${index + 1}`, name: fn.name, arguments: argumentText(fn.arguments) });
    }
  }
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  return { text, toolCalls, finishReason: openAIFinish(choice?.finish_reason, toolCalls) };
}

/** Gemini's function schema is an OpenAPI subset that refuses `additionalProperties`. */
function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  const object = record(value);
  if (!object) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key === 'additionalProperties') continue;
    result[key] = geminiSchema(item);
  }
  return result;
}

function parsedArguments(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) ?? {};
  } catch { return {}; }
}

function geminiContents(messages: AIChatMessage[]): { system: string; contents: unknown[] } {
  const system: string[] = [];
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') { system.push(message.content); continue; }
    if (message.role === 'user') {
      // Gemini wants turns to alternate, so a note after tool results joins them.
      const last = contents[contents.length - 1];
      if (last?.role === 'user') last.parts.push({ text: message.content });
      else contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = message.providerParts?.length ? message.providerParts : [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls ?? []).map(call => ({ functionCall: {
          name: call.name, args: parsedArguments(call.arguments),
          ...(call.id.startsWith(GEMINI_CALL_PREFIX) ? {} : { id: call.id }),
        } })),
      ];
      contents.push({ role: 'model', parts });
      continue;
    }
    // Results of one turn's calls travel together, as Gemini expects.
    const part = { functionResponse: {
      name: message.name, response: { content: message.content },
      ...(message.toolCallId.startsWith(GEMINI_CALL_PREFIX) ? {} : { id: message.toolCallId }),
    } };
    const last = contents[contents.length - 1];
    if (last?.role === 'user') last.parts.push(part);
    else contents.push({ role: 'user', parts: [part] });
  }
  return { system: system.join('\n\n'), contents };
}

async function callGeminiChat(config: AIProviderConfig, request: AIChatRequest, signal?: AbortSignal): Promise<AIChatResult> {
  const { system, contents } = geminiContents(request.messages);
  const data = record(await postGeminiGenerate(config, {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(request.tools?.length ? {
      tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: geminiSchema(tool.parameters) })) }],
    } : {}),
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: outputTokenLimit({ ...config, maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens }),
      // Same as the single-prompt Gemini call.
      thinkingConfig: { thinkingBudget: 0 },
    },
  }, signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const candidate = record(Array.isArray(data?.candidates) ? data.candidates[0] : undefined);
  const parts = Array.isArray(record(candidate?.content)?.parts) ? record(candidate?.content)!.parts as unknown[] : [];
  const text: string[] = [];
  const toolCalls: AIToolCall[] = [];
  for (const item of parts) {
    const part = record(item);
    if (!part || part.thought === true) continue;
    if (typeof part.text === 'string') text.push(part.text);
    const call = record(part.functionCall);
    if (call && typeof call.name === 'string' && call.name) {
      toolCalls.push({ id: typeof call.id === 'string' && call.id ? call.id : `${GEMINI_CALL_PREFIX}${toolCalls.length + 1}`,
        name: call.name, arguments: argumentText(call.args) });
    }
  }
  const reason = candidate?.finishReason;
  const finishReason: AIChatResult['finishReason'] = reason === 'MAX_TOKENS' ? 'length'
    : toolCalls.length ? 'tool_calls' : reason === 'STOP' || reason === undefined ? 'stop' : 'other';
  return { text: text.join('').trim(), toolCalls, finishReason, ...(parts.length ? { providerParts: parts } : {}) };
}

/** One provider call, no retries. */
export async function callAIChat(config: AIProviderConfig, request: AIChatRequest, signal?: AbortSignal): Promise<AIChatResult> {
  signal?.throwIfAborted();
  assertRequestSize(request);
  return config.type === 'gemini'
    ? callGeminiChat(config, request, signal)
    : callOpenAICompatibleChat(config, request, signal);
}

/**
 * A provider call with the shared transient-error retries, plus one more
 * attempt with twice the output budget when a reasoning model spent all of it
 * thinking and returned nothing (`finish_reason: length`, no text, no calls).
 * Treating that as an empty answer is how a correct request came back blank.
 */
export async function callAIChatWithRetry(config: AIProviderConfig, request: AIChatRequest, signal?: AbortSignal): Promise<AIChatResult> {
  const result = await withAIRetry(() => callAIChat(config, request, signal), signal);
  if (result.finishReason !== 'length' || result.text || result.toolCalls.length) return result;
  const budget = outputTokenLimit({ ...config, maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens });
  if (budget >= MAX_OUTPUT_TOKENS) return result;
  const larger = Math.min(MAX_OUTPUT_TOKENS, budget * 2);
  return withAIRetry(() => callAIChat(config, { ...request, maxOutputTokens: larger }, signal), signal);
}
