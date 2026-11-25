/**
 * 集成测试：用 DSH 真实的消息形状走插件适配器，把转发的请求打到真实网关。
 * 目的不是复刻 pi-ai，而是证明三件事：
 *   1) stream() 里 provider 被换回源、messages 被注入、其余字段原样保留
 *   2) 注入后的 messages 能被真实 API 接受（HTTP 200 + 有回复）
 *   3) 工具步/压缩检查点不会被误注入
 *
 * 运行：node integration.mjs
 * 需要 DSH 凭据文件里的 OPENCODE_GO_API_KEY。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as plugin from './index.js';

const URL_ = 'https://opencode.ai/zen/go/v1/chat/completions';
const SESSION = 'weneed-plugin-it-0001';

/** 密钥来源优先级：环境变量 → DSH_CREDENTIALS_FILE → ~/.dsh/.credentials.yaml */
const key = (() => {
  const fromEnv = process.env.OPENCODE_GO_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const cred = process.env.DSH_CREDENTIALS_FILE || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const raw = fs.readFileSync(cred, 'utf8');
  const m = raw.match(/^\s*(?:OPENCODE_GO_API_KEY|CC_SWITCH_DSH_CC_SWITCH_OPEN_CODE_GO)\s*:\s*(\S+)\s*$/m);
  if (!m) throw new Error(`未找到 OPENCODE_GO_API_KEY（环境变量为空，且 ${cred} 里没有）`);
  return m[1];
})();

let seq = 0;
const id = (t) => `${t}-${seq++}`;
const text = (s) => [{ type: 'text', text: s }];

const sys = { id: id('sys'), role: 'system', content: text('你是助手'), source: { kind: 'system-prompt' } };
const ctxRt = { id: id('rt'), role: 'user', content: text('Current runtime context. …'), source: { kind: 'runtime-context' } };
const task = { id: id('u'), role: 'user', content: text('用一句话说明 HTTP 代理和反向代理的区别。'), source: { kind: 'user' } };

const TOOLS = [{
  name: 'noop', description: 'Do nothing.',
  parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
}];

/** 把 DSH 消息转成 OpenAI wire（仅测试用，够表达 text/reasoning/tool 即可）。 */
function toWire(messages) {
  const out = [];
  for (const m of messages) {
    const t = Array.isArray(m.content) ? m.content.find((b) => b.type === 'text')?.text ?? '' : '';
    const r = Array.isArray(m.content) ? m.content.find((b) => b.type === 'reasoning')?.text : undefined;
    if (m.role === 'assistant') {
      const calls = (m.content || []).filter((b) => b.type === 'tool-call');
      const msg = { role: 'assistant', content: t || null };
      if (r !== undefined) msg.reasoning_content = r;
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: t });
    } else {
      out.push({ role: m.role, content: t });
    }
  }
  return out;
}

/** 假的 llm 服务：记录转发内容，并真的打一次网关。 */
function makeCtx(captures) {
  return {
    logger: { info: (s) => console.log('  [plugin]', s) },
    effect: (fn) => { fn(); },
    llm: {
      listProviders: () => ['opencode-go'],
      registerAdapter: (providers, adapter) => {
        captures.adapter = adapter;
        captures.providers = providers;
        return () => {};
      },
      stream: (options) => {
        captures.forwarded = options;
        return (async function* () {
          const body = {
            model: options.model,
            messages: toWire(options.messages),
            max_tokens: 400,
            stream: false,
            reasoning_effort: options.reasoningEffort || 'max',
            ...(Array.isArray(options.tools) && options.tools.length
              ? { tools: options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
              : {}),
          };
          const res = await fetch(URL_, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + key,
              'Content-Type': 'application/json',
              'x-opencode-session': SESSION,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36',
            },
            body: JSON.stringify(body),
          });
          const json = await res.json();
          captures.httpStatus = res.status;
          captures.reply = json?.choices?.[0]?.message ?? json;
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
  };
}

async function callPlugin(messages, tools, effort, extra) {
  const captures = {};
  plugin.apply(makeCtx(captures), {
    sourceProvider: 'opencode-go',
    providerId: 'weneed-opencode-go',
    displayName: '[WeNeed] test',
    models: [{ id: 'deepseek-v4.1-flash', name: 'test' }],
    debug: true,
  });
  const adapter = captures.adapter;
  const prepared = await adapter.prepareCall('weneed-opencode-go', 'deepseek-v4.1-flash', undefined);
  const stream = prepared.stream({
    provider: 'weneed-opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: effort || 'max',
    messages,
    ...(tools ? { tools } : {}),
    ...(extra || {}),
  });
  for await (const _ of stream) { /* 只等完成 */ }
  return captures;
}

console.log('== 场景 1：新用户轮（应注入）==============================');
{
  const c = await callPlugin([sys, ctxRt, task], TOOLS);
  const fwd = c.forwarded;
  const roles = fwd.messages.map((m) => m.role);
  console.log('  provider 已换回源 :', fwd.provider === 'opencode-go');
  console.log('  角色序列          :', roles.join(','));
  console.log('  消息数            :', fwd.messages.length, '(原 3)');
  const seed = fwd.messages.find((m) => m.role === 'assistant');
  console.log('  seed 双通道同文   :', !!seed
    && seed.content.find((b) => b.type === 'text')?.text === seed.content.find((b) => b.type === 'reasoning')?.text);
  console.log('  seed 无 tool-call :', !(seed?.content || []).some((b) => b.type === 'tool-call'));
  console.log('  真实任务在最后    :', fwd.messages.at(-1).id === task.id);
  console.log('  HTTP 状态         :', c.httpStatus);
  const rc = c.reply?.reasoning_content || '';
  const ct = c.reply?.content || '';
  console.log('  回复 reasoning 摘要:', JSON.stringify(rc.slice(0, 120)));
  console.log('  回复 content 摘要 :', JSON.stringify(ct.slice(0, 120)));
  console.log('  语域计数          : We need=%d Need首=%d Let me=%d The user=%d',
    (rc.match(/\bWe need\b/g) || []).length,
    (rc.match(/(?:^|[.!?:]\s+|\n)Need\b/g) || []).length,
    (rc.match(/\bLet me\b/g) || []).length,
    (rc.match(/\bThe user\b/g) || []).length);
}

console.log('\n== 场景 2：工具步（不得注入）==============================');
{
  const a = { id: id('a'), role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'noop', arguments: '{"note":"x"}' }], source: { kind: 'model', provider: 'p', model: 'm' } };
  const t = { id: id('t'), role: 'tool', content: text('ok'), source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' };
  const c = await callPlugin([sys, ctxRt, task, a, t], TOOLS);
  const fwd = c.forwarded;
  console.log('  消息数            :', fwd.messages.length, '(原 5，应不变)');
  console.log('  无新 assistant seed:', fwd.messages.filter((m) => m.role === 'assistant').length === 1);
  console.log('  HTTP 状态         :', c.httpStatus);
}

console.log('\n== 场景 3：压缩检查点之后有新任务（应注入，且在检查点后）==');
{
  const ck = { id: id('ck'), role: 'user', content: text('<compacted-summary>…'), source: { kind: 'compact-checkpoint' } };
  const c = await callPlugin([sys, task, ck, { id: id('u2'), role: 'user', content: text('第二个任务：说一句你好。'), source: { kind: 'user' } }], TOOLS);
  const msgs = c.forwarded.messages;
  const ckIdx = msgs.findIndex((m) => m.source?.kind === 'compact-checkpoint');
  const seedIdx = msgs.findIndex((m) => m.role === 'assistant');
  console.log('  检查点位置        :', ckIdx, ' seed 位置:', seedIdx);
  console.log('  seed 在检查点之后 :', seedIdx > ckIdx);
  console.log('  HTTP 状态         :', c.httpStatus);
}

console.log('\n== 场景 4：mode=off（纯透传）==============================');
{
  const captures = {};
  plugin.apply(makeCtx(captures), {
    sourceProvider: 'opencode-go', providerId: 'weneed-off',
    models: [{ id: 'deepseek-v4.1-flash', name: 't' }], mode: 'off',
  });
  const adapter = captures.adapter;
  const prepared = await adapter.prepareCall('weneed-off', 'deepseek-v4.1-flash', undefined);
  for await (const _ of prepared.stream({ provider: 'weneed-off', model: 'deepseek-v4.1-flash', messages: [sys, ctxRt, task] })) { /* drain */ }
  console.log('  消息数            :', captures.forwarded.messages.length, '(原 3，应不变)');
  console.log('  provider 仍换回源 :', captures.forwarded.provider === 'opencode-go');
}

console.log('\n== 场景 5：标题生成请求（不得注入）========================');
{
  const TITLE_SYS = 'Create a concise title for an AI coding-assistant session from the supplied human messages.\nReturn only the title on one line…';
  const c = await callPlugin([{ id: id('u'), role: 'user', content: text('帮我看看这个代理'), source: { kind: 'user' } }],
    undefined, 'off', { system: TITLE_SYS });
  console.log('  消息数            :', c.forwarded.messages.length, '(原 1，应不变)');
  console.log('  无 seed           :', c.forwarded.messages.filter((m) => m.role === 'assistant').length === 0);
  console.log('  HTTP 状态         :', c.httpStatus);
}

console.log('\n== 场景 6：压缩摘要请求（不得注入）========================');
{
  const CMP = 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.\n\nOutput only the checkpoint text: do not call any tool or take any other action.';
  const c = await callPlugin([sys, task, { id: id('u2'), role: 'user', content: text(CMP), source: { kind: 'user' } }],
    TOOLS, 'max');
  console.log('  消息数            :', c.forwarded.messages.length, '(原 3，应不变)');
  console.log('  无 seed           :', c.forwarded.messages.filter((m) => m.role === 'assistant').length === 0);
  console.log('  HTTP 状态         :', c.httpStatus);
}
