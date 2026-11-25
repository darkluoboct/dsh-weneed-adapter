# WeNeed 适配器

给 DSH 加一个「委托型」模型 provider：**每次新请求发出前，在真实任务之前插入一条 assistant seed**，
让模型保持在 `We need / Need / We should` 的集体规划语态，而不是滑回 `Let me / The user wants me to`。

不启后台进程，不占端口，不改 DSH 配置，随 DSH 启停。

## 它怎么做到的

DSH 有三道门是关着的：

| 位置 | 状态 |
| --- | --- |
| `llm/stream` waterfall | 请求对象 deep-frozen，`next()` 不接受参数 —— 只能读 |
| `agent/request` | 文档明写不能改 messages |
| `agent/pre-step` | 能改，但消息一律落成 `user/message`，造不出 assistant 预填 |

但 `LlmAdapter` 是最低层。它的 `prepareCall()` 返回自己的 `stream(options)`，
而 `ctx.llm.stream()` 是公开方法。**读一个冻结对象、再构造一个新对象，不是修改。**
新对象不在 `AGENT_LOOP_REQUESTS` 这个 WeakSet 里，因此不触发冻结校验。

于是本插件的适配器只做一件事：

```
收到 options（DSH 的完整请求）
  → 判断这次是不是"新用户轮的首个请求"
  → 是：造一个新 messages 数组，插入 [零语义 user 块, assistant seed]
  → 把 provider 改回原值，转调 ctx.llm.stream(新 options)
  → 原样把流交给 DSH
```

SSE 解析、`tool_calls` 分片拼装、`reasoning_content` 回传、usage 记账、图片投影、重试 ——
全部继续由原适配器负责。本插件不碰这些。

## 为什么工具步不插

DeepSeek 官方规定：请求带 `tools` 时，历史 `reasoning_content` 必须回传，且会被拼进上下文。
所以语域靠模型自己每一轮的 reasoning 续下去，工具步重插反而会伪造出「上一轮有 artifact」的假历史。

## 判据是结构化的

DSH 的消息自带 `source.kind`，所以这里不用字符串去猜：

| 判断 | 依据 |
| --- | --- |
| 上下文注入 | `role === 'user'` 且 `source.kind !== 'user'` |
| 压缩检查点 | `source.kind === 'compact-checkpoint'` |
| 工具步 | 跳过尾部上下文后，最后一条是 `role: 'tool'` 或带 `tool-call` 块的 assistant |
| 图片块 | 纯 `image` / `file` 的 user 消息属于上一批工具结果，不是新任务 |

## 配置

改插件行里的 `config` 即可，不用改代码：

```yaml
- id: weneed-adapter
  name: 'dsh-weneed-adapter'
  config:
    sourceProvider: opencode-go      # 必填：请求最终转交给谁
    providerId: weneed-opencode-go   # 本插件注册的新 provider id，必须不同
    displayName: '[WeNeed] OpenCode Go'
    mode: always                     # always | off（off = 纯透传）
    debug: false                     # true 时每条请求打一行日志
    auditPath: ''                    # 审计 jsonl 路径，留空不写
    bridge: 'Context loaded. Goal pending. Tools available.'   # null 关闭
    seed: ''                         # 留空用内置 seed
    models:
      - id: deepseek-v4.1-flash      # 必须与原 provider 的模型 id 一致
        name: DeepSeek V4.1 Flash (WeNeed)
        contextWindow: 1000000
        maxTokens: 384000
        inputModalities: [text, image]
        reasoning:
          defaultEffort: max
          efforts:
            - { id: off, name: Off }
            - { id: high, name: High }
            - { id: max, name: Max }
```

## 验证结果

`node selftest.mjs` —— 不出网，7 条结构断言：

```
ok  跳过全部 runtime-context，定位真实任务
ok  含"会话标题"字样的长历史不再误判（代理版在此失效过）
ok  工具步识别（含尾部 context 追加）
ok  图片 user 不被当成新任务
ok  压缩检查点识别
ok  RequestUserInput（无 source）按真实输入处理
ok  注入形状：system,ctx,ctx,ctx,bridge,seed,task；双通道同文；无标记
```

`node integration.mjs` —— 真机打网关，六个场景全部 HTTP 200：

| 场景 | 结果 |
| --- | --- |
| 新用户轮 | `3 -> 5`，角色 `system,user,user,assistant,user`，HTTP 200 |
| 工具步 | `5 -> 5`，不注入，HTTP 200 |
| 检查点后新任务 | 检查点 index 2，seed index 4，注入在检查点之后，HTTP 200 |
| `mode: off` | `3 -> 3`，纯透传 |
| 标题生成请求 | `1 -> 1`，不注入，HTTP 200 |
| 压缩摘要请求 | `3 -> 3`，不注入，HTTP 200 |

真实回复的 reasoning 实测：

> `We need answer in Chinese one sentence. Need distinguish forward proxy vs reverse proxy. Need understand: …`
> 计数：`We need=1  Need首=2  Let me=0  The user=0`

## 已知边界

- **语域活在 reasoning 层。** 纯陈述型回答的正文两边看不出差异，要展开思考面板才可见。
- **有语法代价。** 内置 seed 用省略式句法（`We need plan`、`Need use`），
  reasoning 里偶尔会出现 `We need need` 这类重复词。
- **`reasoningEffort` 走 `low` 会自毁。** 实测 low 档下模型倾向「跳过噪音直接答」，
  等于把注入清掉。用 `max`。
- **seed 不能带任何标记串。** 任何附加的 `[[marker]]` 都会被模型当成「自己说过的话」复读，
  并随历史累积。识别重复注入靠消息 id 前缀和 content 开头，不靠标记。
- 本插件只改 **messages**，不改 system prompt、不改工具集、不写会话日志。
