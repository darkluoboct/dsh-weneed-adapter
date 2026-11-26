/**
 * 浏览器半边的离线冒烟测试。
 *
 * client.js 是 lazy-CJS factory，正常只在 DSH 的 web 前端里被 __ModuleLoader__ 加载。
 * 这里造一个极简 React 替身 + 假 window，把 factory 拿出来直接渲染几组配置快照，
 * 目标是抓出"语法对、但一渲染就炸"的问题（未定义引用、分支漏 hook、控件漏渲染）。
 *
 * 注意：文案表由 client.js 内部的 apply() 构造，外部传 t 会被忽略，
 * 所以断言只看结构（标签名、id、props），文案正确性用静态键比对覆盖。
 *
 * 运行：node client-smoke.mjs
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'client.js'), 'utf8');

// ── 静态检查一：中英文案键集合必须对齐 ──────────────────────────────────────
const zhBlock = src.split('      zh: {')[1].split('      en: {')[0];
const enBlock = src.split('      en: {')[1].split('    const S = {')[0];
const keysOf = (block) => [...block.matchAll(/^\s{8}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
const zhKeys = keysOf(zhBlock);
const enKeys = keysOf(enBlock);
assert.ok(zhKeys.length > 20, 'zh 文案键解析数量异常：' + zhKeys.length);
assert.deepStrictEqual(zhKeys.slice().sort(), enKeys.slice().sort(), '中英文案键必须一一对应');
console.log('ok  中英两份文案键完全对齐（' + zhKeys.length + ' 个）');

// ── 静态检查二：代码里引用的每个 t.xxx 都在文案表里 ────────────────────────
const used = new Set([...src.matchAll(/\bt\.([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
const missing = [...used].filter((k) => !zhKeys.includes(k));
assert.deepStrictEqual(missing, [], '这些 t.xxx 在文案表里不存在：' + missing.join(', '));
console.log('ok  渲染代码引用的 ' + used.size + ' 个文案键全部有定义');

// ── 极简 React 替身 ─────────────────────────────────────────────────────────
const store = { slots: [], cursor: 0, effects: [] };

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) };
}

const React = {
  createElement,
  useState(init) {
    const i = store.cursor++;
    if (!(i in store.slots)) store.slots[i] = typeof init === 'function' ? init() : init;
    return [store.slots[i], (v) => { store.slots[i] = v; }];
  },
  useEffect(fn) {
    store.effects.push(fn);
  },
  useCallback(fn) {
    return fn;
  },
  useRef(init) {
    const i = store.cursor++;
    if (!(i in store.slots)) store.slots[i] = { current: init };
    return store.slots[i];
  },
};

// ── 把 client.js 里的 factory 取出来 ────────────────────────────────────────
let def = null;
new Function('window', src)({
  __ModuleLoader__: { load(d) { def = d; } },
});

assert.ok(def, 'ModuleLoader.load 没有被调用');
assert.strictEqual(def.id, 'dsh-weneed-adapter');

const mod = def.factory((id) => {
  if (id === 'react') return React;
  throw new Error('意外的 require: ' + id);
});

// ── 假 ctx.slots，抓住注册出来的组件 ────────────────────────────────────────
let registered = null;
mod.apply({
  slots: {
    inject(_name, fn) { return fn(); },
    register(meta, comp) {
      registered = { meta, comp };
      return comp;
    },
  },
});
assert.ok(registered, 'plugins.row.config 没有注册');
assert.strictEqual(registered.meta.key, 'dsh-weneed-adapter#weneed-adapter');
console.log('ok  设置页槽位注册成功');

// ── 渲染工具 ────────────────────────────────────────────────────────────────
function expand(el) {
  if (el === null || el === undefined || el === false || el === true) return null;
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(expand).filter((x) => x !== null);
  if (typeof el.type === 'function') {
    const props = Object.assign({}, el.props);
    if (el.children.length) props.children = el.children.length === 1 ? el.children[0] : el.children;
    return expand(el.type(props));
  }
  return { tag: el.type, props: el.props, children: el.children.map(expand).filter((x) => x !== null) };
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'string') return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  visit(node);
  node.children.forEach((n) => walk(n, visit));
}

function collect(node) {
  const tags = [];
  const inputs = [];
  const selects = [];
  const optgroups = [];
  const options = [];
  const buttons = [];
  const texts = [];
  const dimmed = [];
  walk(node, (n) => {
    tags.push(n.tag);
    if (n.tag === 'input') inputs.push(n.props);
    if (n.tag === 'select') selects.push(n.props);
    if (n.tag === 'optgroup') optgroups.push(n.props);
    if (n.tag === 'option') options.push(n.props);
    if (n.tag === 'button') buttons.push(n.props);
    if (n.props && n.props.style && n.props.style.opacity === 0.55) dimmed.push(n.tag);
    n.children.forEach((c) => { if (typeof c === 'string') texts.push(c); });
  });
  return {
    tags,
    inputs,
    selects,
    optgroups,
    options,
    buttons,
    texts,
    dimmed,
    text: texts.join(' '),
    textInputs: inputs.filter((p) => p.type === 'text'),
    ids: inputs.map((p) => p.id).filter(Boolean),
  };
}

function render(formState, view = 'page') {
  store.slots = [];
  store.cursor = 0;
  store.effects = [];
  return expand(React.createElement(registered.comp, { view, form: { state: formState, mutate: async () => true } }));
}

const ready = (value, extra = {}) => Object.assign({
  status: 'ready', writable: true, revision: 3, value,
}, extra);

// ── 场景 1：快照缺失 → 加载提示 ────────────────────────────────────────────
{
  const c = collect(render(undefined));
  assert.ok(c.tags.includes('p'), '加载态应当渲染一行提示');
  assert.ok(c.text.trim().length > 0, '加载提示应当有文字');
  console.log('ok  快照缺失时渲染加载提示');
}

// ── 场景 2：命名空间不可用 ────────────────────────────────────────────────
{
  const c = collect(render({ status: 'unavailable', value: {}, writable: false }));
  assert.strictEqual(c.tags.length, 1, '不可用态只该有一行提示');
  assert.ok(c.text.trim().length > 0);
  console.log('ok  命名空间不可用时给出单行提示');
}

// ── 场景 3：内置渠道，渠道自带 baseURL ────────────────────────────────────
{
  const c = collect(render(ready({ channel: 'deepseek', mode: 'always', displayName: '', debug: false })));
  assert.strictEqual(c.selects.length, 1, '渠道一个下拉');
  assert.strictEqual(c.optgroups.length, 3, '渠道下拉应当分三组');
  assert.strictEqual(c.options.length, 16, '16 个预置渠道全部在榜');
  assert.strictEqual(c.buttons.length, 6, '工作方式两枚 + 注入模式两枚 + 保存撤销两枚');
  assert.strictEqual(c.textInputs.length, 2, 'deepseek 自带地址：只有密钥名与显示名两个文本框');
  assert.ok(!c.ids.includes('weneed-baseurl'), '自带地址的渠道不该出 baseURL 输入框');
  assert.ok(c.ids.includes('weneed-keyenv') && c.ids.includes('weneed-display'), '关键输入框 id 到位');
  assert.ok(c.ids.includes('weneed-debug'), '调试开关 id 到位');
  assert.strictEqual(c.selects[0].id, 'weneed-channel', '渠道下拉带 id，便于 label 关联');
  console.log('ok  内置渠道渲染完整，自带地址的渠道省掉多余输入框');
}

// ── 场景 4：custom 渠道 → 就地长 Base URL 输入框 ──────────────────────────
{
  const c = collect(render(ready({ channel: 'custom', mode: 'always' })));
  assert.ok(c.ids.includes('weneed-baseurl'), 'custom 渠道必须渲染 baseURL 输入框');
  assert.strictEqual(c.textInputs.length, 3, 'custom 下是三个文本框');
  const url = c.inputs.find((p) => p.id === 'weneed-baseurl');
  assert.strictEqual(url.placeholder, 'https://your-host/v1');
  console.log('ok  custom 渠道就地渲染 Base URL 输入框');
}

// ── 场景 5：commandcode 渠道（地址同样缺）也走输入框分支 ───────────────────
{
  const c = collect(render(ready({ channel: 'commandcode', mode: 'always' })));
  assert.ok(c.ids.includes('weneed-baseurl'), 'baseURL 为空的渠道一律出输入框');
  console.log('ok  地址缺失的预置渠道同样获得输入框');
}

// ── 场景 6：委托模式 → 源 provider 输入框，渠道区收起 ─────────────────────
{
  const c = collect(render(ready({ channel: '', sourceProvider: 'opencode-go', mode: 'always' })));
  assert.ok(c.ids.includes('weneed-source'), '委托模式必须渲染源 provider 输入框');
  assert.strictEqual(c.selects.length, 0, '委托模式下渠道下拉整块收起');
  assert.strictEqual(c.inputs.find((p) => p.id === 'weneed-source').placeholder, 'opencode-go');
  console.log('ok  委托模式渲染源 provider 输入框并收起渠道区');
}

// ── 场景 7：透传模式 → 区块降透明度 + 提示 ────────────────────────────────
{
  const c = collect(render(ready({ channel: 'opencode-go', mode: 'off' })));
  assert.ok(c.dimmed.length >= 1, '透传模式应当把渠道区块降透明度');
  assert.strictEqual(c.selects.length, 1, '控件仍在，只是视觉弱化');
  console.log('ok  透传模式降透明度并保留可编辑');
}

// ── 场景 8：只读配置 → 控件全部禁用 ──────────────────────────────────────
{
  const c = collect(render(ready({ channel: 'deepseek', mode: 'always' }, { writable: false })));
  assert.ok(c.inputs.every((p) => p.disabled === true), '只读时输入框应全禁用');
  assert.ok(c.selects.every((p) => p.disabled === true), '只读时下拉应全禁用');
  console.log('ok  只读配置下所有控件禁用');
}

// ── 场景 9：summary 视图单行输出，带模式 ──────────────────────────────────
{
  const c = collect(render(ready({ channel: 'deepseek', mode: 'off' }), 'summary'));
  assert.ok(c.text.includes('·'), 'summary 应当带模式分隔符');
  assert.strictEqual(c.selects.length, 0, 'summary 里不该有控件');
  assert.strictEqual(c.inputs.length, 0);
  console.log('ok  summary 视图单行输出并携带模式');
}

// ── 场景 10：委托模式的 summary 也要能出字 ────────────────────────────────
{
  const c = collect(render(ready({ channel: '', sourceProvider: 'opencode-go', mode: 'always' }), 'summary'));
  assert.ok(c.text.includes('opencode-go'), '委托模式 summary 应当显示源 provider');
  console.log('ok  委托模式 summary 显示源 provider');
}

console.log('\nCLIENT SMOKE PASSED');
