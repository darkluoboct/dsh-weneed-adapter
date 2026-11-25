/**
 * WeNeed 适配器 —— 浏览器半边
 * ---------------------------------------------------------------------------
 * 注册到设置页的 `plugins.row.config` slot，key 为 `<包名>#<行 id>`。
 * 注册后「设置 > 插件 > WeNeed 适配器」那一行会多出一个「配置」入口，
 * 点进去是本文件渲染的页面。
 *
 * 契约（从 DSH 源码逐字提取）：
 *   props = { t, view, form? }
 *   view  = 'page' | 'summary'
 *   form  = { state: ConfigFormSnapshot, mutate(ops, expectedRevision?): Promise<boolean> }
 *   ConfigFormSnapshot = { status:'loading'|'ready'|'unavailable', value, base, user, revision?, writable }
 *   SettingsPathOpView = { op:'set'; path:string[]; value } | { op:'unset'; path:string[] }
 *
 * 本文件必须是 lazy-CJS factory 格式：window.__ModuleLoader__.load({ id, factory(require) })
 */

window.__ModuleLoader__.load({
  id: 'dsh-weneed-adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useCallback } = React;

    // 与 channels.js 保持一致的渠道清单（浏览器半边不能 import Host 模块）
    const CHANNELS = [
      ['opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', true],
      ['opencode-zen', 'OpenCode Zen', 'https://opencode.ai/zen/v1', true],
      ['deepseek', 'DeepSeek 官方', 'https://api.deepseek.com', true],
      ['commandcode', 'Command Code', '（需自填 baseURL）', false],
      ['zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', false],
      ['moonshot', '月之暗面 Kimi', 'https://api.moonshot.cn/v1', false],
      ['dashscope', '阿里云通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', false],
      ['volces', '火山方舟 / 豆包', 'https://ark.cn-beijing.volces.com/api/v3', false],
      ['siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1', false],
      ['minimax', 'MiniMax', 'https://api.minimax.chat/v1', false],
      ['hunyuan', '腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1', false],
      ['qianfan', '百度千帆', 'https://qianfan.baidubce.com/v2', false],
      ['stepfun', '阶跃星辰', 'https://api.stepfun.com/v1', false],
      ['lingyi', '零一万物', 'https://api.lingyiwanwu.com/v1', false],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', false],
      ['custom', '自定义（自己填 baseURL）', '', true],
    ].map(([id, name, baseURL, verified]) => ({ id, name, baseURL, verified }));

    const isZh = () => {
      const tag = typeof document !== 'undefined' ? document?.documentElement?.lang : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      const lang = typeof navigator !== 'undefined' ? navigator.languages || navigator.language : '';
      const first = Array.isArray(lang) ? lang[0] : lang;
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    };

    const COPY = {
      zh: {
        title: 'WeNeed 渠道',
        hint: '选一个渠道，插件自己发请求；不用在 DSH 里预先注册 provider。',
        channel: '渠道',
        mode: '注入模式',
        modeAlways: '注入 seed',
        modeOff: '纯透传（回滚）',
        apiKeyEnv: '密钥变量名',
        apiKeyHint: '留空用渠道默认。先查环境变量，再查 ~/.dsh/.credentials.yaml 同名 ref。',
        displayName: '显示名',
        displayNameHint: '模型选择器里的分组名，留空为 [WeNeed] <渠道名>',
        debug: '调试日志',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        failed: '保存失败',
        notWritable: '当前配置不可写',
        loading: '读取中…',
        unavailable: '配置命名空间不可用',
        unverified: '未实测',
        verified: '已实测',
        summary: (ch) => '渠道：' + ch,
      },
      en: {
        title: 'WeNeed channel',
        hint: 'Pick a channel; the plugin makes the request itself, with no provider registered in DSH.',
        channel: 'Channel',
        mode: 'Injection mode',
        modeAlways: 'Inject seed',
        modeOff: 'Pass through',
        apiKeyEnv: 'Key variable',
        apiKeyHint: 'Leave empty for the channel default. Env var first, then ~/.dsh/.credentials.yaml ref of the same name.',
        displayName: 'Display name',
        displayNameHint: 'Group name in the model picker; empty means [WeNeed] <channel>',
        debug: 'Debug log',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        notWritable: 'This configuration is not writable',
        loading: 'Loading…',
        unavailable: 'Configuration namespace unavailable',
        unverified: 'unverified',
        verified: 'verified',
        summary: (ch) => 'Channel: ' + ch,
      },
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, padding: '2px 0 8px' },
      hint: { fontSize: 12, opacity: 0.72, lineHeight: 1.5, margin: 0 },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.66, lineHeight: 1.45, margin: 0 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13,
        borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent', color: 'inherit', font: 'inherit',
      },
      actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 },
      btn: {
        padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      },
      status: { fontSize: 12, opacity: 0.75 },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
    };

    function Field({ label, hint, children }) {
      return h('div', { style: S.row },
        h('div', { style: S.label }, label),
        children,
        hint ? h('p', { style: S.sub }, hint) : null);
    }

    function Panel({ t, form, view }) {
      const snapshot = form?.state;
      const value = (snapshot && snapshot.value) || {};
      const currentChannel = typeof value.channel === 'string' && value.channel ? value.channel : 'opencode-go';
      const channelMeta = CHANNELS.find((c) => c.id === currentChannel);

      // hooks 必须在任何 return 之前调用，顺序不能变
      const [draft, setDraft] = useState(null);
      const [state, setState] = useState('idle');

      const effective = draft || {
        channel: currentChannel,
        mode: value.mode === 'off' ? 'off' : 'always',
        apiKeyEnv: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : '',
        displayName: typeof value.displayName === 'string' ? value.displayName : '',
        debug: value.debug === true,
      };

      const effectiveRef = React.useRef(effective);
      effectiveRef.current = effective;

      const patch = useCallback((k, v) => {
        setState('idle');
        setDraft(Object.assign({}, effectiveRef.current, { [k]: v }));
      }, []);

      const save = useCallback(async () => {
        if (!form || typeof form.mutate !== 'function' || !snapshot) return;
        setState('saving');
        const eff = effectiveRef.current;
        const ops = [
          { op: 'set', path: ['channel'], value: eff.channel },
          { op: 'set', path: ['mode'], value: eff.mode },
          { op: 'set', path: ['apiKeyEnv'], value: eff.apiKeyEnv },
          { op: 'set', path: ['displayName'], value: eff.displayName },
          { op: 'set', path: ['debug'], value: eff.debug },
        ];
        try {
          const ok = await form.mutate(ops, snapshot.revision);
          setState(ok ? 'saved' : 'failed');
          if (ok) setDraft(null);
        } catch {
          setState('failed');
        }
      }, [form, snapshot]);

      // summary 视图只出一行字（hooks 已全部调用完）
      if (view === 'summary') {
        return h('span', null, t.summary(channelMeta ? channelMeta.name : currentChannel));
      }

      if (!snapshot) return h('p', { style: S.hint }, t.loading);
      if (snapshot.status === 'unavailable') return h('p', { style: S.hint }, t.unavailable);

      const dirty = draft !== null;
      const disabled = !snapshot.writable || snapshot.status !== 'ready' || state === 'saving';

      return h('div', { style: S.wrap },
        h('p', { style: S.hint }, t.hint),
        h(Field, { label: t.channel },
          h('select', {
            style: S.input,
            value: effective.channel,
            disabled,
            onChange: (e) => patch('channel', e.target.value),
          }, CHANNELS.map((c) => h('option', { key: c.id, value: c.id },
            c.name + ' — ' + (c.verified ? t.verified : t.unverified))))),
        channelMeta && channelMeta.baseURL ? h('p', { style: S.sub }, channelMeta.baseURL) : null,
        h(Field, { label: t.mode },
          h('select', {
            style: S.input,
            value: effective.mode,
            disabled,
            onChange: (e) => patch('mode', e.target.value),
          },
          h('option', { value: 'always' }, t.modeAlways),
          h('option', { value: 'off' }, t.modeOff))),
        h(Field, { label: t.apiKeyEnv, hint: t.apiKeyHint },
          h('input', {
            style: S.input, type: 'text', value: effective.apiKeyEnv, disabled,
            placeholder: 'OPENCODE_GO_API_KEY',
            onChange: (e) => patch('apiKeyEnv', e.target.value),
          })),
        h(Field, { label: t.displayName, hint: t.displayNameHint },
          h('input', {
            style: S.input, type: 'text', value: effective.displayName, disabled,
            placeholder: '[WeNeed] ' + (channelMeta ? channelMeta.name : effective.channel),
            onChange: (e) => patch('displayName', e.target.value),
          })),
        h('label', { style: S.check },
          h('input', {
            type: 'checkbox', checked: effective.debug === true, disabled,
            onChange: (e) => patch('debug', e.target.checked),
          }),
          t.debug),
        h('div', { style: S.actions },
          h('button', {
            style: Object.assign({}, S.btn, { opacity: dirty && !disabled ? 1 : 0.5 }),
            disabled: !dirty || disabled,
            onClick: () => { void save(); },
          }, state === 'saving' ? t.saving : t.save),
          h('span', { style: S.status },
            snapshot.writable ? '' : t.notWritable,
            state === 'saved' ? ' ' + t.saved : '',
            state === 'failed' ? ' ' + t.failed : '')));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const zh = isZh();
        const t = Object.assign(
          (key, ...args) => {
            const v = COPY[zh ? 'zh' : 'en'][key];
            return typeof v === 'function' ? v(...args) : (v ?? key);
          },
          COPY[zh ? 'zh' : 'en'],
        );

        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-weneed-adapter#weneed-adapter',
          id: 'weneed-adapter-config',
          order: 10,
        }, (props) => h(Panel, {
          t,
          form: props.form,
          view: props.view || 'page',
        })));
      },
    };
  },
});
