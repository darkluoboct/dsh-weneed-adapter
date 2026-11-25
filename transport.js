/**
 * 内置传输层：直接对 OpenAI 兼容端点发请求，把 SSE 增量翻译成 DSH 的 StreamChunk。
 * ---------------------------------------------------------------------------
 * 契约（从 DSH 源码提取，非猜测）：
 *   StreamChunk =
 *     | { type:'block-start'; index; blockType }
 *     | { type:'text-delta'; index; text }
 *     | { type:'reasoning-delta'; index; text }
 *     | { type:'tool-call-delta'; index; id; name?; argumentsDelta }
 *     | { type:'block-end'; index; block }
 *     | { type:'usage'; usage: TokenUsage }
 *     | { type:'finish'; reason: FinishReason }
 *   FinishReason = {kind:'stop'} | {kind:'tool-calls'} | {kind:'max-tokens'}
 *                | {kind:'aborted'; failure} | {kind:'error'; failure}
 *   LlmFailure = { message, code, status?, providerRetryAfterMs?, requestId? }
 *   TokenUsage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?,
 *                  cacheWriteTokens?, reasoningTokens? }
 *   ContentBlock = text{text} | reasoning{text} | tool-call{id,name,arguments} | image{attachment} | file{attachment}
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/* ------------------------------------------------------------ 密钥解析 */

/** 从 ~/.dsh/.credentials.yaml 的 refs 段按名字取值（只读，不落盘）。 */
function credentialFromFile(refName) {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(home, '.credentials.yaml');
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const re = new RegExp(`^\\s*${refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(\\S+)\\s*$`, 'm');
    const m = raw.match(re);
    return m ? m[1].replace(/^['"]|['"]$/g, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按优先级解析密钥：显式 config.apiKey → 环境变量 → credentials.yaml 的 ref。
 * 绝不把密钥写进任何日志或返回值。
 */
export function resolveApiKey({ apiKey, apiKeyEnv }) {
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  if (apiKeyEnv && process.env[apiKeyEnv]) return process.env[apiKeyEnv];
  if (apiKeyEnv) {
    const fromFile = credentialFromFile(apiKeyEnv);
    if (fromFile) return fromFile;
  }
  return undefined;
}

/* ---------------------------------------------------------- 消息转换 */

const textOf = (message) => {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('');
};

/** DSH 消息 → OpenAI chat messages。 */
export function toWireMessages(messages, system) {
  const out = [];
  if (typeof system === 'string' && system.trim()) out.push({ role: 'system', content: system });

  for (const m of messages || []) {
    const blocks = Array.isArray(m?.content) ? m.content : [];

    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool-call');
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (reasoning) msg.reasoning_content = reasoning;
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments ?? '{}' },
        }));
      }
      out.push(msg);
      continue;
    }

    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? m.source?.callId ?? 'call_0',
        content: textOf(m),
      });
      continue;
    }

    // user / developer
    const images = blocks.filter((b) => b.type === 'image');
    if (images.length) {
      // 图片需要 attachment 解析，内置传输层不处理，明确降级为文本占位
      const parts = [{ type: 'text', text: textOf(m) }];
      for (const img of images) parts.push({ type: 'text', text: '[image omitted by weneed built-in transport]' });
      out.push({ role: m.role === 'developer' ? 'system' : 'user', content: parts });
    } else {
      out.push({ role: m.role === 'developer' ? 'system' : 'user', content: textOf(m) });
    }
  }
  return out;
}

/** DSH tools → OpenAI tools。 */
export function toWireTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

/* -------------------------------------------------------------- SSE */

function* parseSSE(buffer) {
  // 逐个事件切分；返回剩余未完整的片段由调用方保留
  let idx;
  while ((idx = buffer.indexOf('\n\n')) >= 0) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const lines = raw.split('\n');
    let data = '';
    for (const line of lines) {
      const l = line.trimStart();
      if (l.startsWith('data:')) data += l.slice(5).trimStart();
    }
    if (data) yield data;
  }
  return buffer;
}

/* ------------------------------------------------------------ 主传输 */

/**
 * 流式调用一个 OpenAI 兼容端点，产出 DSH StreamChunk。
 * @param {object} cfg { baseURL, apiKeyEnv, apiKey, extraHeaders, timeoutMs, debug }
 * @param {object} options DSH GenerateOptions
 */
export async function* openaiCompletionsStream(cfg, options) {
  const base = String(cfg.baseURL || '').replace(/\/+$/, '');
  if (!base) {
    yield finishError('weneed: channel has no baseURL — set config.baseURL or pick a valid channel', 'INVALID_CONFIG');
    return;
  }

  const key = resolveApiKey({ apiKey: cfg.apiKey, apiKeyEnv: cfg.apiKeyEnv });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': cfg.userAgent || DEFAULT_UA,
    ...(cfg.extraHeaders || {}),
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  // 部分网关（OpenCode）要求会话头，空值则自动生成
  if (headers['x-opencode-session'] === '') {
    headers['x-opencode-session'] = cfg.sessionId || `dsh-weneed-${Date.now().toString(36)}`;
  }

  const body = {
    model: options.model,
    messages: toWireMessages(options.messages, options.system),
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = toWireTools(options.tools);
  if (tools) body.tools = tools;
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop) body.stop = options.stop;
  if (options.reasoningEffort && options.reasoningEffort !== 'off') {
    body.reasoning_effort = options.reasoningEffort;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = cfg.timeoutMs ? setTimeout(() => controller.abort(), cfg.timeoutMs) : undefined;

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    const aborted = controller.signal.aborted;
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }
        : { kind: 'error', failure: { message: String(error?.message || error), code: 'NETWORK' } },
    };
    return;
  }

  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: detail || `HTTP ${res.status}`,
          code: res.status === 401 ? 'UNAUTHORIZED' : res.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR',
          status: res.status,
        },
      },
    };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let index = -1;
  let current = null; // { kind, index, text?, reasoning?, call? }
  let usage = null;
  let finishReason;

  const startBlock = (kind) => {
    index += 1;
    const blockType = kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text';
    current = { kind, index, blockType, text: '', call: kind === 'tool-call' ? { id: '', name: '', arguments: '' } : null };
    return { type: 'block-start', index, blockType };
  };
  const closeBlock = () => {
    if (!current) return undefined;
    const c = current;
    current = null;
    const block =
      c.kind === 'tool-call'
        ? { type: 'tool-call', id: c.call.id || `call_${c.index}`, name: c.call.name, arguments: c.call.arguments || '{}' }
        : { type: c.blockType, text: c.text };
    return { type: 'block-end', index: c.index, block };
  };

  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let data = '';
        for (const line of rawEvent.split('\n')) {
          const l = line.trimStart();
          if (l.startsWith('data:')) data += l.slice(5).trimStart();
        }
        if (!data) continue;
        if (data === '[DONE]') {
          const close = closeBlock();
          if (close) yield close;
          if (usage) yield { type: 'usage', usage };
          yield finishOf(finishReason);
          return;
        }

        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          const close = closeBlock();
          if (close) yield close;
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: String(json.error.message || json.error), code: 'PROVIDER_ERROR' },
            },
          };
          return;
        }
        if (json.usage) usage = mapUsage(json.usage);

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};

        // reasoning 优先：有些网关把 reasoning 和正文放在同一个 delta
        const rDelta = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
        if (typeof rDelta === 'string' && rDelta) {
          if (!current || current.kind !== 'reasoning') {
            const close = closeBlock();
            if (close) yield close;
            yield startBlock('reasoning');
          }
          current.text += rDelta;
          yield { type: 'reasoning-delta', index: current.index, text: rDelta };
        }

        if (typeof delta.content === 'string' && delta.content) {
          if (!current || current.kind !== 'text') {
            const close = closeBlock();
            if (close) yield close;
            yield startBlock('text');
          }
          current.text += delta.content;
          yield { type: 'text-delta', index: current.index, text: delta.content };
        }

        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          for (const tc of delta.tool_calls) {
            if (!current || current.kind !== 'tool-call') {
              const close = closeBlock();
              if (close) yield close;
              yield startBlock('tool-call');
            }
            const fn = tc.function || {};
            if (tc.id && !current.call.id) current.call.id = tc.id;
            if (fn.name && !current.call.name) current.call.name = fn.name;
            const argsDelta = fn.arguments || '';
            current.call.arguments += argsDelta;
            yield {
              type: 'tool-call-delta',
              index: current.index,
              id: current.call.id || `call_${current.index}`,
              ...(fn.name ? { name: fn.name } : {}),
              argumentsDelta: argsDelta,
            };
          }
        }
      }
    }
  } catch (error) {
    if (current) {
      const close = closeBlock();
      if (close) yield close;
    }
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
    const aborted = controller.signal.aborted;
    yield {
      type: 'finish',
      reason: aborted
        ? { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }
        : { kind: 'error', failure: { message: String(error?.message || error), code: 'STREAM' } },
    };
    return;
  }

  clearTimeout(timer);
  if (options.signal) options.signal.removeEventListener('abort', onAbort);
  const close = closeBlock();
  if (close) yield close;
  if (usage) yield { type: 'usage', usage };
  yield finishOf(finishReason);
}

function finishOf(reason) {
  if (reason === 'tool_calls' || reason === 'tool-calls') return { type: 'finish', reason: { kind: 'tool-calls' } };
  if (reason === 'length') return { type: 'finish', reason: { kind: 'max-tokens' } };
  return { type: 'finish', reason: { kind: 'stop' } };
}

function finishError(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

function mapUsage(u) {
  const out = {
    inputTokens: Number(u.prompt_tokens) || 0,
    outputTokens: Number(u.completion_tokens) || 0,
  };
  if (Number.isFinite(u.total_tokens)) out.totalTokens = u.total_tokens;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  if (Number.isFinite(cached)) out.cacheReadTokens = cached;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoning)) out.reasoningTokens = reasoning;
  return out;
}
