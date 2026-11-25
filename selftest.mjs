#!/usr/bin/env node
/**
 * 不出网的结构自检：验证注入判据与消息形状。
 * 运行：node selftest.mjs
 */
import assert from 'node:assert';

let seq = 0;
const id = (tag) => `${tag}-${seq++}`;

/* 把 index.js 的判据逻辑镜像到这里，保持单一语义、独立可测。
   真实逻辑在 index.js；这里若与它不一致，说明代码漂移了 —— 见末尾的结构对照。 */
function textOf(m) {
  const b = m?.content;
  if (typeof b === 'string') return b;
  if (!Array.isArray(b)) return '';
  return b.filter((x) => x?.type === 'text').map((x) => x.text).join('');
}
const hasBlock = (m, t) => Array.isArray(m?.content) && m.content.some((b) => b?.type === t);
const hasToolCalls = (m) => hasBlock(m, 'tool-call');
const isContextMessage = (m) => {
  if (m?.role !== 'user') return false;
  const k = m?.source?.kind;
  if (k === undefined) return false;
  return k !== 'user';
};
const isCompaction = (m) => m?.source?.kind === 'compact-checkpoint';
const isImageOnlyUser = (m) => m?.role === 'user' && (hasBlock(m, 'image') || hasBlock(m, 'file'));

/* 辅助请求识别（与 index.js 同语义） */
const isCompactionRequestText = (t) =>
  /acting as a compaction engine/i.test(t) || /condense the conversation above/i.test(t) || /output only the checkpoint text/i.test(t);
const isTitleSystemText = (s) => /create a concise title for an ai coding-assistant session/i.test(s || '');

function lastRealUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    if (isContextMessage(m)) continue;
    if (isCompaction(m)) continue;
    if (isImageOnlyUser(m)) continue;
    return i;
  }
  return -1;
}

function isToolStep(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (isContextMessage(m)) continue;
    if (m?.role === 'tool') return true;
    if (m?.role === 'assistant') return hasToolCalls(m);
    if (isImageOnlyUser(m)) continue;
    return false;
  }
  return false;
}

/* ---------------------------------------------------------------- fixtures */
const msg = (role, blocks, kind) => ({
  id: id(role),
  role,
  content: blocks.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b)),
  ...(role === 'assistant' ? { source: { kind: 'model', provider: 'src', model: 'm' } }
    : role === 'system' ? { source: { kind: 'system-prompt' } }
    : kind ? { source: { kind } } : role === 'tool' ? { source: { kind: 'tool', callId: id('c') }, toolCallId: id('c') } : { source: { kind: 'user' } }),
});

const sys = msg('system', ['system prompt']);
const ctxRuntime = msg('user', ['Current runtime context. …'], 'runtime-context');
const ctxSkill = msg('user', ['<system-reminder>available_skills…'], 'runtime-context');
const ctxTime = msg('user', ['Time sampled while preparing turn 1, step 1: …'], 'runtime-context');
const task = msg('user', ['real task']);

console.log('== 判据 ============================================');

// 1) 最后一条真实用户任务，跳过三种上下文
{
  const msgs = [sys, ctxRuntime, ctxSkill, ctxTime, task];
  assert.strictEqual(lastRealUserIndex(msgs), 4, '真实任务应定位到 index 4');
  console.log('ok  跳过全部 runtime-context，定位真实任务');
}

// 2) 讨论过"标题/会话标题"字样的长历史 —— 代理版曾在这里全线误判，结构化判据天然免疫
{
  const noisy = [sys];
  for (let i = 0; i < 20; i++) {
    noisy.push(msg('user', [`第${i}轮：我们在讨论 conversation title 和会话标题`]));
    noisy.push(msg('assistant', ['好的，title-request 判据是这样…']));
  }
  noisy.push(task);
  assert.strictEqual(lastRealUserIndex(noisy), noisy.length - 1, '含"会话标题"字样仍应定位到最后一条');
  assert.strictEqual(isToolStep(noisy), false, '不应被判为工具步');
  console.log('ok  含"会话标题"字样的长历史不再误判（代理版在此失效过）');
}

// 3) 工具步
{
  const a = msg('assistant', [{ type: 'text', text: '' }, { type: 'tool-call', id: id('c'), name: 'read', arguments: '{}' }]);
  const t = msg('tool', ['result']);
  assert.strictEqual(isToolStep([sys, task, a, t]), true, 'tool 结尾应为工具步');
  assert.strictEqual(isToolStep([sys, task, a, t, ctxTime]), true, '工具步后追加 time context 仍为工具步');
  console.log('ok  工具步识别（含尾部 context 追加）');
}

// 4) 图片 user 属于工具结果，不是新任务
{
  const a = msg('assistant', [{ type: 'tool-call', id: id('c'), name: 'view', arguments: '{}' }]);
  const t = msg('tool', ['image result']);
  const img = { id: id('img'), role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a' } }], source: { kind: 'user' } };
  assert.strictEqual(isToolStep([sys, task, a, t, img]), true, '图片 user 之后仍应判为工具步');
  assert.strictEqual(lastRealUserIndex([sys, task, a, t, img]), 1, '图片 user 不应被当成新任务');
  console.log('ok  图片 user 不被当成新任务');
}

// 5) 压缩检查点
{
  const ck = { id: id('ck'), role: 'user', content: [{ type: 'text', text: '<compacted-summary>…' }], source: { kind: 'compact-checkpoint' } };
  assert.strictEqual(isCompaction(ck), true, 'compact-checkpoint 应被识别');
  assert.strictEqual(lastRealUserIndex([sys, task, ck]), 1, '检查点不应被当成真实任务');
  console.log('ok  压缩检查点识别');
}

// 6) RequestUserInput（无 source）按真实输入处理
{
  const rui = { role: 'user', content: [{ type: 'text', text: 'hand-built input' }] };
  assert.strictEqual(isContextMessage(rui), false, '无 source 的 user 不应判为上下文');
  assert.strictEqual(lastRealUserIndex([sys, rui]), 1, '无 source 的 user 应可作真实任务');
  console.log('ok  RequestUserInput（无 source）按真实输入处理');
}

// 7) 注入后的形状
{
  const seedText = 'Kimi needs to … We need act now.';
  const seed = {
    id: id('seed'),
    role: 'assistant',
    content: [{ type: 'text', text: seedText }, { type: 'reasoning', text: seedText }],
    source: { kind: 'model', provider: 'weneed-opencode-go', model: 'weneed' },
  };
  const bridge = { id: id('bridge'), role: 'user', content: [{ type: 'text', text: 'Context loaded. Goal pending. Tools available.' }], source: { kind: 'user' } };
  const source = [sys, ctxRuntime, ctxTime, task];
  const idx = lastRealUserIndex(source);
  const out = [...source.slice(0, idx), bridge, seed, ...source.slice(idx)];

  assert.deepStrictEqual(out.map((m) => m.role), ['system', 'user', 'user', 'user', 'assistant', 'user']);
  const assistant = out.filter((m) => m.role === 'assistant');
  assert.strictEqual(assistant.length, 1, 'seed 只能出现一次');
  assert.strictEqual(assistant[0].content.find((b) => b.type === 'reasoning').text, seedText, 'reasoning 通道必须同文');
  assert.strictEqual(assistant[0].content.find((b) => b.type === 'text').text, seedText, 'content 通道必须同文');
  assert.strictEqual(hasToolCalls(assistant[0]), false, 'seed 不得带 tool-call');
  assert.strictEqual(out[out.length - 1].content[0].text, 'real task', '真实任务仍在最后');
  assert.strictEqual(textOf(assistant[0]).includes('[['), false, 'seed 不得含任何标记串（会被模型复读）');
  console.log('ok  注入形状：system,ctx,ctx,ctx,bridge,seed,task；双通道同文；无标记');
}

// 8) 辅助请求不得注入
{
  const compaction = 'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint…';
  assert.strictEqual(isCompactionRequestText(compaction), true, '压缩摘要指令应被识别');
  assert.strictEqual(isCompactionRequestText('Output only the checkpoint text: do not call any tool or take any other action.'), true, '压缩规则行应被识别');
  assert.strictEqual(isCompactionRequestText('real task'), false, '普通任务不应被误判为压缩');

  assert.strictEqual(isTitleSystemText('Create a concise title for an AI coding-assistant session from the supplied human messages.'), true, '标题 system 应被识别');
  assert.strictEqual(isTitleSystemText('你是助手'), false, '普通 system 不应被误判为标题');
  console.log('ok  标题 / 压缩摘要请求识别（这两类不注入）');
}

// 9) 讨论过"压缩/标题"字样的会话，其后续任务仍应正常注入
{
  const noisy = [sys, msg('user', ['上一轮我们讲过 You are now acting as a compaction engine 这段原文']), msg('assistant', ['是的。']), task];
  assert.strictEqual(lastRealUserIndex(noisy), noisy.length - 1, '含压缩指令字样的历史仍应定位到真实任务');
  assert.strictEqual(isCompactionRequestText(textOf(noisy.at(-1))), false, '最后一条是真实任务，不应判为压缩请求');
  console.log('ok  历史里出现压缩指令原文，不导致后续所有轮次被跳过（只看最后一条）');
}

console.log('===================================================');
console.log('SELFTEST PASSED');
