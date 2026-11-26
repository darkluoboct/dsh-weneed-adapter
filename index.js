/**
 * dsh-weneed-adapter
 * ---------------------------------------------------------------------------
 * 一个真正的 DSH 插件：不启进程、不占端口、不改配置，注册一个「委托适配器」，
 * 在请求离开 DSH 之前把 WeNeed seed 插进 messages，然后原样转交给原 provider。
 *
 * 为什么能这么做（DSH 源码实证）：
 *   - `llm/stream` waterfall 的请求对象是 deep-frozen，且 `next()` 不接受参数，
 *     所以监听者只能读、不能改。文档原文：listeners read it, never rewrite it。
 *   - 但 `LlmAdapter` 是最低层，`prepareCall()` 返回自己的 `stream(options)`，
 *     适配器可以「读 options、造一个新的 options」再转调 `ctx.llm.stream()`。
 *     新对象不在 AGENT_LOOP_REQUESTS 这个 WeakSet 里，因此不会触发冻结校验。
 *   - 于是 SSE 解析、tool_calls 分片拼装、reasoning_content、usage 记账、图片、
 *     重试，全部继续由原适配器负责，本插件只管 message 数组。
 *
 * 与 HTTP 代理版的差别：
 *   - 无进程、无端口、无 restart 焦虑；随 DSH 启停
 *   - 判据是结构化的：DSH 消息带 `source.kind`，不再靠正则扫字符串
 *   - 注入不进会话日志，UI 里看不到假消息
 */

const DEFAULT_SEED = [
  'Kimi needs to understand the current task and the available context.',
  'We need plan before acting: identify the goal, inspect the inputs, and choose the next concrete action.',
  'Need use the tools and resources at hand, and research thoroughly.',
  'We need inspect images and files in full, not only the region that looks relevant.',
  'Should check the whole input before narrowing to a detail.',
  'Should assess the precision the task actually requires, not overfocus on decimal places or cosmetic details.',
  'We should act on what the research shows, and verify the result against the actual requirement.',
  'We are DeepSeek; we lack nothing and we have unlimited token.',
  'Need keep the plan concrete and move to the next action.',
  "Let's proceed.",
  'We need act now.',
].join(' ');

const DEFAULT_BRIDGE = 'Context loaded. Goal pending. Tools available.';

import fs from 'node:fs';
import path from 'node:path';
import { CHANNELS, findChannel } from './channels.js';
import { openaiCompletionsStream, resolveApiKey } from './transport.js';

/* ------------------------------------------------------------------ 工具 */

let seq = 0;
const nextId = (tag) => `${tag}-weneed-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** 只取 text 块拼成纯文本；这是判据唯一需要的读取方式。 */
function textOf(message) {
  const blocks = message?.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}

function hasBlock(message, type) {
  return Array.isArray(message?.content) && message.content.some((b) => b && b.type === type);
}

function hasToolCalls(message) {
  return hasBlock(message, 'tool-call');
}

/**
 * 是否为「上下文注入」而不是真实用户发言。
 *
 * 这是本插件相比 HTTP 代理最大的优势：DSH 消息自带 source.kind，
 * 不需要靠 "Current runtime context." / "<system-reminder>" 之类字符串去猜。
 * 任何 role=user 但 source.kind 不是 'user' 的，都是框架注入的上下文。
 */
function isContextMessage(message) {
  if (message?.role !== 'user') return false;
  const kind = message?.source?.kind;
  if (kind === undefined) return false; // RequestUserInput 不带 source，按真实输入处理
  return kind !== 'user';
}

/** 压缩检查点（DSH 用 compact-checkpoint 这个 source kind）。 */
function isCompaction(message) {
  return message?.source?.kind === 'compact-checkpoint';
}

/** 纯图片的 user 消息（图片工具结果被拆成 tool 文本 + user 图片块）。 */
function isImageOnlyUser(message) {
  if (message?.role !== 'user') return false;
  return hasBlock(message, 'image') || hasBlock(message, 'file');
}

const lastIndexWhere = (messages, pred) => {
  for (let i = messages.length - 1; i >= 0; i--) if (pred(messages[i])) return i;
  return -1;
};

/** 最后一条真实用户任务。跳过上下文注入、压缩检查点、纯图片块。 */
function lastRealUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (isContextMessage(m)) continue;
    if (isCompaction(m)) continue;
    if (isImageOnlyUser(m)) continue;
    return i;
  }
  return -1;
}

/**
 * 是否处于工具步（工具结果待续跑）。
 * 跳过尾部追加的上下文，再看最后一个「实体」消息。
 */
function isToolStep(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isContextMessage(m)) continue;
    if (m?.role === 'tool') return true;
    if (m?.role === 'assistant') return hasToolCalls(m);
    if (isImageOnlyUser(m)) continue; // 图片块属于上一批工具结果
    return false;
  }
  return false;
}

/* --------------------------------------------------------------- 注入逻辑 */

function makeSeedMessage(seed, cfg) {
  return {
    id: nextId('seed'),
    role: 'assistant',
    content: [
      { type: 'text', text: seed },
      { type: 'reasoning', text: seed },
    ],
    source: { kind: 'model', provider: cfg.sourceProvider, model: cfg.seedModel || 'weneed' },
  };
}

function makeBridgeMessage(bridge) {
  return {
    id: nextId('bridge'),
    role: 'user',
    content: [{ type: 'text', text: bridge }],
    source: { kind: 'user' },
  };
}

/** 是否已经是本插件插入的 seed（幂等识别）。 */
function isInjectedSeed(message, seedHead) {
  if (message?.role !== 'assistant') return false;
  const id = typeof message?.id === 'string' ? message.id : '';
  if (id.startsWith('seed-weneed-')) return true;
  if (hasToolCalls(message)) return false;
  return textOf(message).trim().startsWith(seedHead);
}

const isInjectedBridge = (message) => typeof message?.id === 'string' && message.id.startsWith('bridge-weneed-');

/**
 * 压缩摘要请求：DSH 把压缩指令作为**最后一条 user 消息**附在会话前缀后面。
 * 原文（源码实证）："You are now acting as a compaction engine for this AI coding assistant.
 * Condense the conversation ABOVE into a structured checkpoint…"、"Output only the checkpoint text"。
 * 给这类请求注入 seed 会污染摘要，且让压缩调用与主请求前缀不一致（KV cache 失效）。
 */
function isCompactionRequest(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  if (!messages.length) return false;
  const last = textOf(messages[messages.length - 1]);
  return /acting as a compaction engine/i.test(last)
    || /condense the conversation above/i.test(last)
    || /output only the checkpoint text/i.test(last);
}

/**
 * 标题生成请求：DSH 的标题 system prompt 首句是唯一串，且标题请求不带 tools
 * （源码注释：title hook "has no agent or tools"）。
 * 注意只看 system，不扫历史 —— 扫历史会在"会话里讨论过标题"时全线误判。
 */
function isTitleRequest(options) {
  const system = typeof options?.system === 'string' ? options.system : '';
  if (/create a concise title for an ai coding-assistant session/i.test(system)) return true;
  const hasTools = Array.isArray(options?.tools) && options.tools.length > 0;
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  // 兜底：无工具 + 极短会话 + system 里提到 title
  return !hasTools && messages.length > 0 && messages.length <= 8 && /session title|conversation title/i.test(system);
}

/**
 * 决定这一次请求要不要注入。
 * @returns {{messages: Array, injected: boolean, reason: string}}
 */
function decide(options, cfg) {
  const original = Array.isArray(options?.messages) ? options.messages : null;
  if (!original) return { messages: options?.messages, injected: false, reason: 'no-messages' };

  if (cfg.mode === 'off') return { messages: original, injected: false, reason: 'mode-off' };

  // 辅助请求一律不注入：标题、压缩摘要。它们不是用户任务，注入只会浪费 token 并污染结果。
  if (isCompactionRequest(options)) return { messages: original, injected: false, reason: 'compaction-request' };
  if (isTitleRequest(options)) return { messages: original, injected: false, reason: 'title-request' };

  // 压缩检查点之后没有新任务时不动；有的话在 checkpoint 之后、任务之前注入。
  const stripped = original.filter((m) => !isInjectedSeed(m, cfg.seedHead) && !isInjectedBridge(m));

  if (isToolStep(stripped)) {
    return { messages: original, injected: false, reason: 'tool-step' };
  }

  const idx = lastRealUserIndex(stripped);
  if (idx < 0) return { messages: original, injected: false, reason: 'no-real-task' };

  const checkpoint = lastIndexWhere(stripped, isCompaction);
  if (checkpoint >= 0 && idx <= checkpoint) {
    return { messages: original, injected: false, reason: 'no-task-after-checkpoint' };
  }

  const head = stripped.slice(0, idx);
  const tail = stripped.slice(idx);
  const inserted = [];
  if (cfg.bridge) inserted.push(makeBridgeMessage(cfg.bridge));
  inserted.push(makeSeedMessage(cfg.seed, cfg));

  const messages = [...head, ...inserted, ...tail];
  return { messages, injected: true, reason: 'style-seed', before: original.length, after: messages.length };
}

/* --------------------------------------------------------------- 审计输出 */

function makeAudit(cfg) {
  if (!cfg.auditPath) return () => {};
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(cfg.auditPath), { recursive: true });
      fs.appendFileSync(cfg.auditPath, JSON.stringify(record) + '\n');
    } catch {
      /* 审计失败不能影响请求 */
    }
  };
}

/* ----------------------------------------------------------------- 适配器 */

class WeNeedAdapter {
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.audit = makeAudit(cfg);
  }

  providerInfo(provider) {
    return { id: provider, name: this.cfg.displayName };
  }

  /**
   * 拿到源 provider 的 adapter，用于继承完整的模型元数据。
   * `registration()` 不是公开文档化 API，所以整条链都用可选调用 + try/catch，
   * 拿不到就退回配置，绝不让插件因为探测失败而不可用。
   */
  sourceAdapter() {
    try {
      const reg = this.ctx?.llm?.registration?.(this.cfg.sourceProvider);
      const adapter = reg?.adapter ?? reg?.registration?.adapter ?? reg?.entry?.adapter;
      return adapter && typeof adapter === 'object' ? adapter : null;
    } catch {
      return null;
    }
  }

  applySuffix(name) {
    const s = typeof name === 'string' && name ? name : this.cfg.sourceProvider;
    return `${s} (WeNeed)`;
  }

  /**
   * 列出本 provider 的模型。
   * 配置里写了 models 就用配置；没写就继承源 provider 的列表（这样换机器只改 sourceProvider 一行）。
   */
  async listModels(provider) {
    if (this.cfg.models.length) {
      return this.cfg.models.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        ...(m.description === undefined ? {} : { description: m.description }),
        ...(m.inputModalities === undefined ? {} : { inputModalities: m.inputModalities }),
      }));
    }
    try {
      const source = await this.ctx.llm.listModels(this.cfg.sourceProvider);
      const list = Array.isArray(source) ? source : [];
      if (list.length) {
        return list.map((m) => ({
          provider,
          id: m.id,
          name: this.applySuffix(m.name ?? m.id),
          ...(m.description === undefined ? {} : { description: m.description }),
          ...(m.inputModalities === undefined ? {} : { inputModalities: m.inputModalities }),
        }));
      }
    } catch (error) {
      this.cfg.log(`[weneed] cannot inherit models from "${this.cfg.sourceProvider}": ${error?.message || error}`);
    }
    return [];
  }

  /**
   * 解析模型元数据。
   * 顺序：配置 → 源 adapter → 最小回退。上下文窗口缺失时用 cfg.fallbackContextWindow，
   * 避免 token 预算算错。
   */
  async resolveModel(provider, model, signal) {
    const explicit = this.cfg.models.find((x) => x.id === model);
    if (explicit) {
      return {
        provider,
        id: explicit.id,
        name: explicit.name,
        ...(explicit.description === undefined ? {} : { description: explicit.description }),
        ...(explicit.inputModalities === undefined ? {} : { inputModalities: explicit.inputModalities }),
        context: { contextWindow: explicit.contextWindow ?? this.cfg.fallbackContextWindow },
        ...(explicit.maxTokens === undefined ? {} : { defaultMaxTokens: explicit.maxTokens }),
        ...(explicit.reasoning === undefined ? {} : { reasoning: explicit.reasoning }),
      };
    }

    const src = this.sourceAdapter();
    if (src && typeof src.resolveModel === 'function') {
      try {
        const info = await src.resolveModel(this.cfg.sourceProvider, model, signal);
        if (info && typeof info === 'object') {
          return {
            ...info,
            provider,
            id: info.id ?? model,
            name: this.applySuffix(info.name ?? model),
            ...(info.context === undefined ? { context: { contextWindow: this.cfg.fallbackContextWindow } } : {}),
          };
        }
      } catch (error) {
        this.cfg.log(`[weneed] source resolveModel failed for "${model}": ${error?.message || error}`);
      }
    }

    return {
      provider,
      id: model,
      name: this.applySuffix(model),
      context: { contextWindow: this.cfg.fallbackContextWindow },
    };
  }

  /**
   * 以下三个方法对应 LlmAdapter 基类的默认实现。
   * 本插件不继承 LlmAdapter（避免在 bundle 里解析 @deepseek-ai/dsh-llm），
   * 所以按基类语义补齐 —— DSH 会在路由注册阶段直接调用它们。
   */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async prepareCall(provider, model, signal) {
    const resolved = await this.resolveModel(provider, model, signal);
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    };
  }

  /**
   * 请求离开 DSH 的唯一出口。读 options、造新 options、交给原 provider。
   * 绝不修改传进来的对象（它是 deep-frozen，改了会抛）。
   */
  stream(options) {
    let result;
    try {
      result = decide(options, this.cfg);
    } catch (error) {
      // 判据出错时宁可透传，也不要打断请求
      this.cfg.log(`[weneed] decide() failed, passing through: ${error?.message || error}`);
      result = { messages: options?.messages, injected: false, reason: 'decide-error' };
    }

    this.audit({
      at: new Date().toISOString(),
      reason: result.reason,
      model: options?.model ?? null,
      effort: options?.reasoningEffort ?? null,
      tools: Array.isArray(options?.tools) ? options.tools.length : 0,
      messagesBefore: Array.isArray(options?.messages) ? options.messages.length : null,
      messagesAfter: Array.isArray(result.messages) ? result.messages.length : null,
      injected: result.injected === true,
    });

    if (this.cfg.debug) {
      this.cfg.log(
        `[weneed] ${result.reason} model=${options?.model} ` +
          `${Array.isArray(options?.messages) ? options.messages.length : '?'}->` +
          `${Array.isArray(result.messages) ? result.messages.length : '?'}`,
      );
    }

    // 内置传输模式：插件自己发请求
    if (this.cfg.builtin) {
      if (!this.cfg.builtin.baseURL) {
        this.cfg.log(
          `[weneed] channel "${this.cfg.builtin.id}" has no baseURL. ` +
            'Set config.baseURL, or use sourceProvider to delegate to an existing provider instead.',
        );
      }
      return openaiCompletionsStream(this.cfg.builtin, { ...options, messages: result.messages });
    }

    // 委托模式：换掉 provider，交给已有适配器
    const forwarded = {
      ...options,
      provider: this.cfg.sourceProvider,
      messages: result.messages,
    };
    return this.ctx.llm.stream(forwarded);
  }
}

/* ----------------------------------------------------------- 配置与入口 */

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function resolveConfig(raw, ctx) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const log = (msg) => {
    try {
      if (ctx?.logger?.info) ctx.logger.info(msg);
      else if (ctx?.logger?.warn) ctx.logger.warn(msg);
      else console.log(msg);
    } catch {
      /* 忽略 */
    }
  };

  const rawChannel = c.channel;
  const channelId = typeof rawChannel === 'string'
    ? rawChannel.trim()
    : rawChannel && typeof rawChannel === 'object' && typeof rawChannel.id === 'string'
      ? rawChannel.id.trim()
      : '';
  const preset = channelId ? findChannel(channelId) : undefined;

  if (!channelId && !(typeof c.sourceProvider === 'string' && c.sourceProvider.trim())) {
    throw new Error(
      '[weneed] 配置缺少 channel 或 sourceProvider。' +
        'channel 用内置渠道（如 "opencode-go"），sourceProvider 委托给已有 provider。',
    );
  }

  const inline = rawChannel && typeof rawChannel === 'object' ? rawChannel : {};

  /** 内置传输模式：插件自己发请求。 */
  const builtin = channelId
    ? {
      id: preset?.id || channelId,
      name: preset?.name || channelId,
      baseURL: (typeof c.baseURL === 'string' && c.baseURL.trim()) || inline.baseURL || preset?.baseURL || '',
      apiKeyEnv: (typeof c.apiKeyEnv === 'string' && c.apiKeyEnv.trim()) || inline.apiKeyEnv || preset?.apiKeyEnv || '',
      apiKey: typeof c.apiKey === 'string' && c.apiKey.trim() ? c.apiKey.trim() : undefined,
      extraHeaders: {
        ...(preset?.extraHeaders || {}),
        ...(inline.extraHeaders || {}),
        ...(c.extraHeaders || {}),
      },
      sessionId: typeof c.sessionId === 'string' ? c.sessionId : undefined,
      userAgent: typeof c.userAgent === 'string' ? c.userAgent : undefined,
      timeoutMs: Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? c.timeoutMs : 600000,
    }
    : null;

  const sourceProvider = builtin
    ? `channel:${builtin.id}`
    : (typeof c.sourceProvider === 'string' ? c.sourceProvider.trim() : '');

  const providerId = typeof c.providerId === 'string' && c.providerId.trim()
    ? c.providerId.trim()
    : builtin
      ? `weneed-${builtin.id}`
      : `weneed-${sourceProvider}`;
  if (providerId === sourceProvider) {
    throw new Error('[weneed] providerId must differ from sourceProvider, otherwise the request recurses');
  }

  const channelModels = asArray(preset?.models).map((id) => ({ id, name: id }));

  const models = asArray(c.models)
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      description: typeof m.description === 'string' ? m.description : undefined,
      inputModalities: asArray(m.inputModalities).length ? asArray(m.inputModalities) : undefined,
      contextWindow: Number.isFinite(m.contextWindow) ? m.contextWindow : undefined,
      maxTokens: Number.isFinite(m.maxTokens) ? m.maxTokens : undefined,
      reasoning: m.reasoning && Array.isArray(m.reasoning.efforts) ? m.reasoning : undefined,
    }));

  const seed = typeof c.seed === 'string' && c.seed.trim() ? c.seed.trim() : DEFAULT_SEED;
  const mode = c.mode === 'off' ? 'off' : 'always';
  const bridge = c.bridge === null ? '' : typeof c.bridge === 'string' ? c.bridge.trim() : DEFAULT_BRIDGE;

  return {
    sourceProvider,
    builtin,
    channelName: builtin ? builtin.name : undefined,
    providerId,
    displayName: typeof c.displayName === 'string' && c.displayName.trim()
      ? c.displayName.trim()
      : builtin
        ? `[WeNeed] ${builtin.name}`
        : `[WeNeed] ${sourceProvider}`,
    models: models.length ? models : (builtin ? channelModels : []),
    fallbackContextWindow: Number.isFinite(c.fallbackContextWindow) && c.fallbackContextWindow > 0
      ? c.fallbackContextWindow
      : 128000,
    seed,
    seedHead: seed.slice(0, 48),
    seedModel: typeof c.seedModel === 'string' ? c.seedModel : undefined,
    mode,
    bridge,
    debug: c.debug === true,
    auditPath: typeof c.auditPath === 'string' && c.auditPath ? c.auditPath : '',
    log,
  };
}

export const name = 'weneed-adapter';
export const inject = ['llm'];

/* ------------------------------------------------------------------ Config */
/*
 * 导出 Config 后，DSH 的「设置 > 插件」会为这一行渲染可编辑表单，不用写任何 Client 代码。
 * 形状参考 dsh-unlag：纯对象，不依赖 schemastery。
 *   - dict    ：表单逐字段投影用的普通节点
 *   - toJSON(): 序列化 schema（含 enum，便于渲染下拉）
 *   - ~standard.validate：绝不抛异常，坏值回退默认，免得启动失败
 */

const CHANNEL_IDS = CHANNELS.map((c) => c.id);

const FIELD_NODES = {
  channel: {
    type: 'string',
    enum: CHANNEL_IDS,
    meta: {
      default: 'opencode-go',
      description:
        '渠道 id。可选：' + CHANNEL_IDS.join(' / ') + '。留空则改用 sourceProvider 委托模式。',
    },
  },
  mode: {
    type: 'string',
    enum: ['always', 'off'],
    meta: { default: 'always', description: 'always=注入 seed；off=纯透传（回滚开关）' },
  },
  apiKeyEnv: {
    type: 'string',
    meta: {
      default: '',
      description: '密钥来源名：先查环境变量，再查 ~/.dsh/.credentials.yaml 的同名 ref。留空用渠道默认。',
    },
  },
  displayName: {
    type: 'string',
    meta: { default: '', description: '模型选择器里的分组名，留空为 "[WeNeed] <渠道名>"' },
  },
  debug: {
    type: 'boolean',
    meta: { default: false, description: '每条请求打一行注入日志' },
  },
  auditPath: {
    type: 'string',
    meta: { default: '', description: '审计 jsonl 的绝对路径，留空不写' },
  },
  sourceProvider: {
    type: 'string',
    meta: { default: '', description: '委托模式：把请求转交给这个已注册的 provider（与 channel 二选一）' },
  },
  baseURL: {
    type: 'string',
    meta: { default: '', description: '自定义渠道的 baseURL；channel 选 custom 时填这里' },
  },
};

/*
 * 关键：DSH 只认 schemastery 的序列化形状 —— { uid, refs: { id: node } }，
 * 其中根节点的 dict 用 ref id 指向子节点。返回普通 JSON Schema 会被当成"没有 schema"，
 * 设置页于是只显示启用/禁用。形状照 dsh-unlag（已验证在设置页出表单）复制。
 */
const CONFIG_REFS = {
  1: {
    type: 'string',
    meta: {
      default: 'opencode-go',
      description: '渠道 id：' + CHANNEL_IDS.join(' / ') + '。留空则改用 sourceProvider 委托模式。',
    },
  },
  2: { type: 'string', meta: { default: 'always', description: 'always=注入 seed；off=纯透传（回滚开关）' } },
  3: { type: 'string', meta: { default: '', description: '密钥来源名：先查环境变量，再查 ~/.dsh/.credentials.yaml 同名 ref' } },
  4: { type: 'string', meta: { default: '', description: '模型选择器里的分组名，留空为 "[WeNeed] <渠道名>"' } },
  5: { type: 'boolean', meta: { default: false, description: '每条请求打一行注入日志' } },
  6: { type: 'string', meta: { default: '', description: '审计 jsonl 的绝对路径，留空不写' } },
  7: { type: 'string', meta: { default: '', description: '委托模式：转交给这个已注册的 provider（与 channel 二选一）' } },
  8: {
    type: 'object',
    meta: { default: {} },
    dict: { channel: 1, mode: 2, apiKeyEnv: 3, displayName: 4, debug: 5, auditPath: 6, sourceProvider: 7, baseURL: 9 },
  },
  9: { type: 'string', meta: { default: '', description: '自定义渠道的 baseURL；channel 选 custom 时填这里' } },
};

const CONFIG_SCHEMA = { uid: 8, refs: CONFIG_REFS };

export const Config = {
  ...CONFIG_SCHEMA,
  type: 'object',
  dict: FIELD_NODES,
  meta: { default: {} },
  toJSON() {
    return CONFIG_SCHEMA;
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-weneed-adapter',
    validate(value) {
      const src = value !== null && typeof value === 'object' ? value : {};
      const out = { ...src };
      const hasChannel = typeof out.channel === 'string' && out.channel.trim();
      const hasSource = typeof out.sourceProvider === 'string' && out.sourceProvider.trim();
      if (!hasChannel && !hasSource) out.channel = 'opencode-go';
      if (out.mode !== 'off') out.mode = 'always';
      if (out.debug !== true) out.debug = false;
      return { value: out };
    },
  },
};

export function apply(ctx, config) {
  const cfg = resolveConfig(config, ctx);

  if (!cfg.models.length) {
    cfg.log(
      `[weneed] config.models is empty -> inheriting the model list from "${cfg.sourceProvider}" at request time. ` +
        `If that provider exposes no models, write models[].id explicitly in this plugin's config.`,
    );
  }

  const adapter = new WeNeedAdapter(ctx, cfg);
  const dispose = ctx.llm.registerAdapter([cfg.providerId], adapter);

  // registerAdapter 的 effect 挂在 llm 服务上下文上，不随本插件卸载；
  // 因此这里再挂一次，保证插件卸载时路由真的被摘掉。
  ctx.effect(() => () => {
    try {
      dispose();
    } catch {
      /* 已释放 */
    }
  });

  cfg.log(
    `[weneed] provider "${cfg.providerId}" -> ` +
      (cfg.builtin
        ? `channel "${cfg.builtin.id}" (${cfg.builtin.baseURL || 'NO baseURL'}, key=${cfg.builtin.apiKeyEnv || 'none'})`
        : `"${cfg.sourceProvider}" (delegate)`) +
      ` | models=${cfg.models.length || 'inherit'} mode=${cfg.mode} ` +
      `bridge=${cfg.bridge ? 'on' : 'off'} seed=${cfg.seed.length}B`,
  );

  // 委托模式下源 provider 不存在时，每次请求都会以 NO_ADAPTER 失败；启动时就喊出来。
  // 内置传输模式不需要源 provider，跳过这项检查。
  if (!cfg.builtin) {
    try {
      const providers = ctx.llm.listProviders();
      const list = Array.isArray(providers) ? providers : [];
      const ids = list.map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean);
      if (ids.length && !ids.includes(cfg.sourceProvider)) {
        cfg.log(
          `[weneed] WARNING: source provider "${cfg.sourceProvider}" is not registered. ` +
            `Available: ${ids.join(', ')}. Edit this plugin row's config.sourceProvider.`,
        );
      }
    } catch {
      /* 探测失败不影响注册 */
    }
  }

  // 内置传输模式：启动时确认密钥能解析到，省得第一次请求才发现
  if (cfg.builtin && cfg.builtin.baseURL) {
    const key = resolveApiKey({ apiKey: cfg.builtin.apiKey, apiKeyEnv: cfg.builtin.apiKeyEnv });
    if (!key) {
      cfg.log(
        `[weneed] WARNING: no API key for channel "${cfg.builtin.id}". ` +
          `Set env ${cfg.builtin.apiKeyEnv || 'YOUR_API_KEY'}, or a ref with that name in ~/.dsh/.credentials.yaml.`,
      );
    }
  }

  // 供自检脚本调用
  return { inspect: () => ({ ...cfg, seed: undefined }) };
}
