/**
 * WeNeed 适配器 —— 浏览器半边 v2
 * ---------------------------------------------------------------------------
 * 注册到设置页的 `plugins.row.config` slot，key 为 `<包名>#<行 id>`。
 *
 * 契约（从 DSH 源码逐字提取）：
 *   props = { t, view, form? }
 *   view  = 'page' | 'summary'
 *   form  = { state: ConfigFormSnapshot, mutate(ops, expectedRevision?): Promise<boolean> }
 *   ConfigFormSnapshot = { status:'loading'|'ready'|'unavailable', value, base, user, revision?, writable }
 *   SettingsPathOpView = { op:'set'; path:string[]; value } | { op:'unset'; path:string[] }
 *
 * v2 相对 v1 的变化：
 *   - 工作方式分段：内置渠道 / 委托 provider，两种模式都能在页面上配
 *   - 渠道下拉按「已实测 / 公开兼容端点 / 自定义」分组，去掉每行的「未实测」尾巴
 *   - 渠道自带的 baseURL 为空时（custom、commandcode）就地渲染输入框
 *   - 密钥变量名的 placeholder 跟着渠道走
 *   - 显示名下方实时预览模型选择器里的样子
 *   - 草稿可撤销，改动可感知，保存失败区分 revision 冲突与一般错误
 *   - 透传模式下其余字段降透明度提示"现在不生效"
 *   - 每个控件带 id，label 用 htmlFor 关联
 *
 * 本文件必须是 lazy-CJS factory 格式：window.__ModuleLoader__.load({ id, factory(require) })
 */

window.__ModuleLoader__.load({
  id: 'dsh-weneed-adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /**
     * 与 channels.js 保持一致（浏览器半边读不到 Host 模块，只能各存一份）。
     * group: tested = 本仓库实测过；untested = 公开兼容端点；custom = 自己填地址
     */
    const CHANNELS = [
      ['opencode-go', 'OpenCode Go', 'https://opencode.ai/zen/go/v1', 'OPENCODE_GO_API_KEY', 'tested'],
      ['opencode-zen', 'OpenCode Zen', 'https://opencode.ai/zen/v1', 'OPENCODE_API_KEY', 'tested'],
      ['deepseek', 'DeepSeek 官方', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY', 'tested'],
      ['commandcode', 'Command Code', '', 'COMMANDCODE_API_KEY', 'untested'],
      ['zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4', 'ZHIPU_API_KEY', 'untested'],
      ['moonshot', '月之暗面 Kimi', 'https://api.moonshot.cn/v1', 'MOONSHOT_API_KEY', 'untested'],
      ['dashscope', '阿里云通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 'untested'],
      ['volces', '火山方舟 / 豆包', 'https://ark.cn-beijing.volces.com/api/v3', 'ARK_API_KEY', 'untested'],
      ['siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1', 'SILICONFLOW_API_KEY', 'untested'],
      ['minimax', 'MiniMax', 'https://api.minimax.chat/v1', 'MINIMAX_API_KEY', 'untested'],
      ['hunyuan', '腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1', 'HUNYUAN_API_KEY', 'untested'],
      ['qianfan', '百度千帆', 'https://qianfan.baidubce.com/v2', 'QIANFAN_API_KEY', 'untested'],
      ['stepfun', '阶跃星辰', 'https://api.stepfun.com/v1', 'STEPFUN_API_KEY', 'untested'],
      ['lingyi', '零一万物', 'https://api.lingyiwanwu.com/v1', 'LINGYI_API_KEY', 'untested'],
      ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'untested'],
      ['custom', '自定义', '', 'CUSTOM_API_KEY', 'custom'],
    ].map(([id, name, baseURL, apiKeyEnv, group]) => ({ id, name, baseURL, apiKeyEnv, group }));

    const byGroup = (g) => CHANNELS.filter((c) => c.group === g);
    const findChannel = (id) => CHANNELS.find((c) => c.id === id);

    const isZh = () => {
      const tag = typeof document !== 'undefined' ? document?.documentElement?.lang : '';
      if (/^zh(-|$)/i.test(tag)) return true;
      const lang = typeof navigator !== 'undefined' ? navigator.languages || navigator.language : '';
      const first = Array.isArray(lang) ? lang[0] : lang;
      return typeof first === 'string' && /^zh(-|$)/i.test(first);
    };

    const COPY = {
      zh: {
        title: 'WeNeed 适配器',
        hint: '两种接法二选一：插件自己打渠道，或者把请求转交给 DSH 里已有的 provider。',
        how: '工作方式',
        howBuiltin: '内置渠道',
        howDelegate: '委托 provider',
        howBuiltinHint: '插件自己发请求，填渠道 + 密钥变量名即可',
        howDelegateHint: '转交给 ctx.llm.listProviders() 里已经注册的 provider',
        channel: '渠道',
        baseURL: 'Base URL',
        baseURLHint: '这个渠道要自己填地址，例如 https://your-host/v1',
        baseURLMissing: '先填 Base URL 再保存',
        sourceProvider: '源 provider',
        sourceProviderHint: '填已注册的 provider id，例如 opencode-go',
        sourceMissing: '先填源 provider 再保存',
        mode: '注入模式',
        modeAlways: '注入 seed',
        modeOff: '纯透传',
        passThroughNote: '透传模式下渠道设置暂停生效',
        apiKeyEnv: '密钥变量名',
        apiKeyHint: '留空用渠道默认。顺序：环境变量 → ~/.dsh/.credentials.yaml 同名 ref',
        displayName: '显示名',
        displayNameHint: '模型选择器里的分组名，留空自动生成',
        preview: '模型选择器将显示',
        debug: '调试日志',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        revert: '撤销',
        dirty: '有未保存的改动',
        errConflict: '配置刚被别处改过，刷新页面后重试',
        errGeneric: '保存失败，看 Host 日志',
        notWritable: '当前配置可写性受限',
        loading: '读取中…',
        unavailable: '配置命名空间不可用',
        groupTested: '已实测',
        groupUntested: '公开兼容端点',
        groupCustom: '自定义',
        summary: (ch, mode) => '渠道：' + ch + ' · ' + mode,
        summaryBuiltin: '内置',
        summaryDelegate: '委托',
        summaryAlways: '注入中',
        summaryOff: '透传',
      },
      en: {
        title: 'WeNeed adapter',
        hint: 'Two wirings, pick one: talk to a channel directly, or delegate to a provider already registered in DSH.',
        how: 'Wiring',
        howBuiltin: 'Built-in channel',
        howDelegate: 'Delegate provider',
        howBuiltinHint: 'The plugin issues the request itself; supply a channel plus a key variable',
        howDelegateHint: 'Hand the request to a provider registered in ctx.llm.listProviders()',
        channel: 'Channel',
        baseURL: 'Base URL',
        baseURLHint: 'This channel needs its own address, e.g. https://your-host/v1',
        baseURLMissing: 'Fill in Base URL first',
        sourceProvider: 'Source provider',
        sourceProviderHint: 'A registered provider id, e.g. opencode-go',
        sourceMissing: 'Fill in the source provider first',
        mode: 'Injection mode',
        modeAlways: 'Inject seed',
        modeOff: 'Pass through',
        passThroughNote: 'Channel settings are idle while passing through',
        apiKeyEnv: 'Key variable',
        apiKeyHint: 'Empty means the channel default. Order: env var → ~/.dsh/.credentials.yaml ref',
        displayName: 'Display name',
        displayNameHint: 'Group name in the model picker; empty means auto',
        preview: 'Model picker will show',
        debug: 'Debug log',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        revert: 'Revert',
        dirty: 'Unsaved changes',
        errConflict: 'Config changed elsewhere; refresh and retry',
        errGeneric: 'Save failed; check the host log',
        notWritable: 'This configuration is read-limited',
        loading: 'Loading…',
        unavailable: 'Configuration namespace unavailable',
        groupTested: 'Verified',
        groupUntested: 'Public compatible endpoints',
        groupCustom: 'Custom',
        summary: (ch, mode) => 'Channel: ' + ch + ' · ' + mode,
        summaryBuiltin: 'built-in',
        summaryDelegate: 'delegate',
        summaryAlways: 'seeding',
        summaryOff: 'passthrough',
      },
    };

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, padding: '2px 0 8px' },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      title: { fontSize: 14, fontWeight: 700, margin: 0 },
      hint: { fontSize: 12, opacity: 0.72, lineHeight: 1.55, margin: 0 },
      section: {
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: '10px 12px', borderRadius: 8,
        border: '1px solid rgba(127,127,127,0.22)',
      },
      sectionIdle: { opacity: 0.55 },
      row: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 13, fontWeight: 600 },
      sub: { fontSize: 12, opacity: 0.66, lineHeight: 1.45, margin: 0 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: 13,
        borderRadius: 6, border: '1px solid rgba(127,127,127,0.35)',
        background: 'transparent', color: 'inherit', font: 'inherit',
      },
      inputBad: { borderColor: '#d64545' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      seg: { display: 'inline-flex', gap: 4, padding: 3, borderRadius: 7, background: 'rgba(127,127,127,0.12)' },
      segBtn: {
        padding: '5px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer',
        border: '1px solid transparent', background: 'transparent', color: 'inherit', fontWeight: 500,
      },
      segBtnOn: {
        background: 'rgba(127,127,127,0.22)', borderColor: 'rgba(127,127,127,0.35)', fontWeight: 700,
      },
      actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 },
      btn: {
        padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
      },
      btnPrimary: { borderColor: '#3b82f6', color: '#3b82f6', fontWeight: 600 },
      status: { fontSize: 12, opacity: 0.78, display: 'flex', alignItems: 'center', gap: 6 },
      dot: { width: 7, height: 7, borderRadius: 4, display: 'inline-block', flex: '0 0 auto' },
      check: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 },
      preview: { fontSize: 12, opacity: 0.8, margin: 0 },
      previewMono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
    };

    const TONE = {
      ok: '#2e9e5b',
      warn: '#d69e2e',
      err: '#d64545',
      idle: 'rgba(127,127,127,0.45)',
    };

    function Dot({ tone }) {
      return h('span', { style: Object.assign({}, S.dot, { background: TONE[tone] || TONE.idle }) });
    }

    function Field({ id, label, hint, children }) {
      return h('div', { style: S.row },
        h('label', { htmlFor: id, style: S.label }, label),
        children,
        hint ? h('p', { style: S.sub }, hint) : null);
    }

    function Segmented({ id, value, options, onChange, disabled }) {
      return h('div', { style: S.seg, id, role: 'radiogroup' },
        options.map((o) => h('button', {
          key: o.value,
          type: 'button',
          role: 'radio',
          'aria-checked': value === o.value,
          disabled,
          style: Object.assign({}, S.segBtn, value === o.value ? S.segBtnOn : null),
          onClick: () => onChange(o.value),
        }, o.label)));
    }

    function Panel({ t, form, view }) {
      const snapshot = form?.state;
      const value = (snapshot && snapshot.value) || {};

      const hasChannel = typeof value.channel === 'string' && value.channel.trim();
      const hasSource = typeof value.sourceProvider === 'string' && value.sourceProvider.trim();
      const summaryMode = value.mode === 'off' ? t.summaryOff : t.summaryAlways;
      const summaryTarget = hasChannel
        ? (findChannel(value.channel)?.name || value.channel)
        : (hasSource ? value.sourceProvider : '-');

      // hooks 一律在 return 之前调用，顺序固定
      const [draft, setDraft] = useState(null);
      const [state, setState] = useState('idle');
      const [error, setError] = useState(null);

      const base = {
        workMode: (!hasChannel && hasSource) ? 'delegate' : 'builtin',
        channel: hasChannel ? value.channel : 'opencode-go',
        baseURL: typeof value.baseURL === 'string' ? value.baseURL : '',
        sourceProvider: hasSource ? value.sourceProvider : '',
        mode: value.mode === 'off' ? 'off' : 'always',
        apiKeyEnv: typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : '',
        displayName: typeof value.displayName === 'string' ? value.displayName : '',
        debug: value.debug === true,
      };

      const effective = draft || base;
      const effRef = useRef(effective);
      effRef.current = effective;

      // 「已保存」两秒半后自然褪去，回到中性态
      useEffect(() => {
        if (state !== 'saved') return undefined;
        const id = setTimeout(() => setState('idle'), 2500);
        return () => clearTimeout(id);
      }, [state]);

      const patch = useCallback((k, v) => {
        setState('idle');
        setError(null);
        setDraft(Object.assign({}, effRef.current, { [k]: v }));
      }, []);

      const revert = useCallback(() => {
        setDraft(null);
        setState('idle');
        setError(null);
      }, []);

      const save = useCallback(async () => {
        if (!form || typeof form.mutate !== 'function' || !snapshot) return;
        const eff = effRef.current;

        if (eff.workMode === 'builtin' && eff.channel === 'custom' && !eff.baseURL.trim()) {
          setState('failed');
          setError('needBaseURL');
          return;
        }
        if (eff.workMode === 'delegate' && !eff.sourceProvider.trim()) {
          setState('failed');
          setError('needSource');
          return;
        }

        setState('saving');
        setError(null);

        const ops = [
          { op: 'set', path: ['mode'], value: eff.mode },
          { op: 'set', path: ['debug'], value: eff.debug },
          { op: 'set', path: ['baseURL'], value: eff.baseURL.trim() },
          { op: 'set', path: ['apiKeyEnv'], value: eff.apiKeyEnv.trim() },
          { op: 'set', path: ['displayName'], value: eff.displayName.trim() },
        ];
        if (eff.workMode === 'delegate') {
          ops.push({ op: 'set', path: ['sourceProvider'], value: eff.sourceProvider.trim() });
          ops.push({ op: 'set', path: ['channel'], value: '' });
        } else {
          ops.push({ op: 'set', path: ['channel'], value: eff.channel });
          ops.push({ op: 'set', path: ['sourceProvider'], value: '' });
        }

        try {
          const ok = await form.mutate(ops, snapshot.revision);
          if (ok) {
            setState('saved');
            setError(null);
            setDraft(null);
          } else {
            setState('failed');
            setError('conflict');
          }
        } catch (err) {
          setState('failed');
          const msg = String((err && err.message) || err || '');
          setError(/revision|conflict|stale|409/i.test(msg) ? 'conflict' : 'generic');
        }
      }, [form, snapshot]);

      // summary 视图只出一行字（hooks 已经全部调用完）
      if (view === 'summary') {
        return h('span', null, t.summary(
          summaryTarget,
          hasChannel || hasSource
            ? (hasChannel ? summaryMode : t.summaryDelegate + ' · ' + summaryMode)
            : summaryMode,
        ));
      }

      if (!snapshot) return h('p', { style: S.hint }, t.loading);
      if (snapshot.status === 'unavailable') return h('p', { style: S.hint }, t.unavailable);

      const dirty = draft !== null;
      const disabled = !snapshot.writable || snapshot.status !== 'ready' || state === 'saving';
      const idle = effective.mode === 'off';
      const channelMeta = findChannel(effective.channel);
      const needsURL = effective.workMode === 'builtin' && !!channelMeta && !channelMeta.baseURL;
      const keyPlaceholder = (channelMeta && channelMeta.apiKeyEnv) || 'YOUR_API_KEY';
      const previewName = effective.displayName.trim()
        || ('[WeNeed] ' + (channelMeta ? channelMeta.name : effective.channel));
      const urlBad = error === 'needBaseURL';
      const sourceBad = error === 'needSource';

      const tone = state === 'failed' ? 'err'
        : state === 'saved' ? 'ok'
          : dirty ? 'warn'
            : snapshot.writable ? 'ok' : 'idle';

      const statusText = state === 'saving' ? t.saving
        : state === 'saved' ? t.saved
          : error === 'needBaseURL' ? t.baseURLMissing
            : error === 'needSource' ? t.sourceMissing
              : error === 'conflict' ? t.errConflict
                : error === 'generic' ? t.errGeneric
                  : dirty ? t.dirty
                    : (snapshot.writable ? '' : t.notWritable);

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h(Dot, { tone }),
          h('h3', { style: S.title }, t.title)),
        h('p', { style: S.hint }, t.hint),

        // ── 工作方式 ────────────────────────────────────────────────
        h('div', { style: S.row },
          h('div', { style: S.label }, t.how),
          h(Segmented, {
            id: 'weneed-workmode',
            value: effective.workMode,
            disabled,
            options: [
              { value: 'builtin', label: t.howBuiltin },
              { value: 'delegate', label: t.howDelegate },
            ],
            onChange: (v) => patch('workMode', v),
          }),
          h('p', { style: S.sub },
            effective.workMode === 'delegate' ? t.howDelegateHint : t.howBuiltinHint)),

        // ── 内置渠道 ────────────────────────────────────────────────
        effective.workMode === 'builtin' ? h('div', {
          style: Object.assign({}, S.section, idle ? S.sectionIdle : null),
        },
        h(Field, { id: 'weneed-channel', label: t.channel },
          h('select', {
            id: 'weneed-channel',
            style: S.input,
            value: effective.channel,
            disabled,
            onChange: (e) => patch('channel', e.target.value),
          },
          h('optgroup', { label: t.groupTested },
            byGroup('tested').map((c) => h('option', { key: c.id, value: c.id }, c.name))),
          h('optgroup', { label: t.groupUntested },
            byGroup('untested').map((c) => h('option', { key: c.id, value: c.id }, c.name))),
          h('optgroup', { label: t.groupCustom },
            byGroup('custom').map((c) => h('option', { key: c.id, value: c.id }, c.name))))),

        needsURL ? h(Field, { id: 'weneed-baseurl', label: t.baseURL, hint: t.baseURLHint },
          h('input', {
            id: 'weneed-baseurl',
            style: Object.assign({}, S.input, urlBad ? S.inputBad : null, S.mono),
            type: 'text',
            value: effective.baseURL,
            disabled,
            placeholder: 'https://your-host/v1',
            onChange: (e) => patch('baseURL', e.target.value),
          }))
          : h('p', { style: Object.assign({}, S.sub, S.mono) }, channelMeta ? channelMeta.baseURL : ''),

        h(Field, { id: 'weneed-keyenv', label: t.apiKeyEnv, hint: t.apiKeyHint },
          h('input', {
            id: 'weneed-keyenv',
            style: Object.assign({}, S.input, S.mono),
            type: 'text',
            value: effective.apiKeyEnv,
            disabled,
            placeholder: keyPlaceholder,
            onChange: (e) => patch('apiKeyEnv', e.target.value),
          })))
          : null,

        // ── 委托 provider ───────────────────────────────────────────
        effective.workMode === 'delegate' ? h('div', {
          style: Object.assign({}, S.section, idle ? S.sectionIdle : null),
        },
        h(Field, { id: 'weneed-source', label: t.sourceProvider, hint: t.sourceProviderHint },
          h('input', {
            id: 'weneed-source',
            style: Object.assign({}, S.input, sourceBad ? S.inputBad : null, S.mono),
            type: 'text',
            value: effective.sourceProvider,
            disabled,
            placeholder: 'opencode-go',
            onChange: (e) => patch('sourceProvider', e.target.value),
          })))
          : null,

        // ── 注入模式 ────────────────────────────────────────────────
        h('div', { style: S.row },
          h('div', { style: S.label }, t.mode),
          h(Segmented, {
            id: 'weneed-mode',
            value: effective.mode,
            disabled,
            options: [
              { value: 'always', label: t.modeAlways },
              { value: 'off', label: t.modeOff },
            ],
            onChange: (v) => patch('mode', v),
          }),
          idle ? h('p', { style: S.sub }, t.passThroughNote) : null),

        // ── 显示名 ──────────────────────────────────────────────────
        h(Field, { id: 'weneed-display', label: t.displayName, hint: t.displayNameHint },
          h('input', {
            id: 'weneed-display',
            style: S.input,
            type: 'text',
            value: effective.displayName,
            disabled,
            placeholder: '[WeNeed] ' + (channelMeta ? channelMeta.name : effective.channel),
            onChange: (e) => patch('displayName', e.target.value),
          }),
          h('p', { style: S.preview }, t.preview + '：',
            h('span', { style: S.previewMono }, previewName))),

        // ── 调试 ────────────────────────────────────────────────────
        h('label', { style: S.check, htmlFor: 'weneed-debug' },
          h('input', {
            id: 'weneed-debug',
            type: 'checkbox',
            checked: effective.debug === true,
            disabled,
            onChange: (e) => patch('debug', e.target.checked),
          }),
          t.debug),

        // ── 动作 ────────────────────────────────────────────────────
        h('div', { style: S.actions },
          h('button', {
            type: 'button',
            style: Object.assign({}, S.btn, S.btnPrimary, { opacity: dirty && !disabled ? 1 : 0.45 }),
            disabled: !dirty || disabled,
            onClick: () => { void save(); },
          }, state === 'saving' ? t.saving : t.save),
          h('button', {
            type: 'button',
            style: Object.assign({}, S.btn, { opacity: dirty ? 0.9 : 0.35 }),
            disabled: !dirty || state === 'saving',
            onClick: revert,
          }, t.revert),
          h('span', { style: S.status },
            statusText ? h(Dot, { tone }) : null,
            statusText)));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const zh = isZh();
        const dict = COPY[zh ? 'zh' : 'en'];
        const t = Object.assign(
          (key, ...args) => {
            const v = dict[key];
            return typeof v === 'function' ? v(...args) : (v ?? key);
          },
          dict,
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
