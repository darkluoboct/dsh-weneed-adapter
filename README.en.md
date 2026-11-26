# dsh-weneed-adapter

A DeepSeek Harness plugin that injects a **WeNeed register seed** into model requests.
No proxy process, no port, no config surgery — it starts and stops with DSH.

It keeps the model in the collective planning register — `We need / Need / We should` —
instead of sliding back to `Let me / The user wants me to`.

[中文说明](README.md)

## What it does

DSH freezes the `llm/stream` request object, `agent/request` cannot rewrite `messages`,
and `agent/pre-step` can only append a user message. An `LlmAdapter` is the one seam that
can read the outgoing request and build a new one — so this plugin registers a delegating
adapter and prepends the seed there.

Result: one extra `user` message ahead of the real task, with no visible marker in the
transcript, and nothing injected into tool steps, title requests, or compaction summaries.

## Install

The plugin ships as a DSH **bundle**. Four steps, zero changes to DSH internals.

### 1. Get the code

```bash
git clone https://github.com/darkluoboct/dsh-weneed-adapter.git
```

### 2. Register it in your profile

Edit `~/.dsh/profiles/<profile>/package.json`
(on Windows: `C:\Users\<you>\.dsh\profiles\<profile>\package.json`):

```json
{
  "private": true,
  "dependencies": {
    "dsh-weneed-adapter": "link:/absolute/path/to/dsh-weneed-adapter"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-weneed-adapter"
      ]
    }
  }
}
```

You can also point `dependencies` straight at the repo and skip the clone:

```json
"dsh-weneed-adapter": "github:darkluoboct/dsh-weneed-adapter"
```

### 3. Install and restart

```bash
cd ~/.dsh/profiles/<profile>
pnpm install
```

Restart DSH. The plugin lives and dies with the host — there is no sidecar process and
no port to babysit.

### 4. Configure

Append to `cordis.patch.yml` in the same directory:

```yaml
- insert:
    - id: weneed-adapter
      name: 'dsh-weneed-adapter'
      config:
        channel: deepseek     # switching channels means changing this one line
        mode: always
```

> The home-level `~/.dsh/cordis.patch.yml` is for `insert` only. Put `config` in the
> profile layer, otherwise it shadows the settings UI and you get
> `overridden by a home patch` when you edit the plugin from the UI.

Once loaded, a new group shows up in the model picker. `mode: off` is a pure passthrough
and acts as the rollback switch.

## Two modes

| Mode | Config key | Behaviour |
| --- | --- | --- |
| **A — built-in channel** (recommended) | `channel: opencode-go` | The plugin issues the HTTP request itself. You supply a channel plus a key; a matching provider inside DSH is optional. |
| **B — delegate** | `sourceProvider: opencode-go` | Hands the request to a provider already registered in DSH. Use it when another plugin already owns that channel. |

Both wirings switch from the `Wiring` control on the settings page; editing `cordis.patch.yml` by hand is an equivalent entry point.

## Built-in channels

```bash
node list-channels.mjs          # list them all
node list-channels.mjs 国内      # filter by keyword
```

| channel id | name | baseURL | key env var | verified |
| --- | --- | --- | --- | --- |
| `opencode-go` | OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` | ✅ live |
| `opencode-zen` | OpenCode Zen | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` | ✅ config |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | ✅ docs |
| `commandcode` | Command Code | *fill in* | `COMMANDCODE_API_KEY` | ⚠️ see note |
| `zhipu` | Zhipu GLM | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | ⚠️ untested |
| `moonshot` | Moonshot Kimi | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | ⚠️ untested |
| `dashscope` | Alibaba Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | ⚠️ untested |
| `volces` | Volcengine Ark | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` | ⚠️ untested |
| `siliconflow` | SiliconFlow | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | ⚠️ untested |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` | `MINIMAX_API_KEY` | ⚠️ untested |
| `hunyuan` | Tencent Hunyuan | `https://api.hunyuan.cloud.tencent.com/v1` | `HUNYUAN_API_KEY` | ⚠️ untested |
| `qianfan` | Baidu Qianfan | `https://qianfan.baidubce.com/v2` | `QIANFAN_API_KEY` | ⚠️ untested |
| `stepfun` | StepFun | `https://api.stepfun.com/v1` | `STEPFUN_API_KEY` | ⚠️ untested |
| `lingyi` | 01.AI | `https://api.lingyiwanwu.com/v1` | `LINGYI_API_KEY` | ⚠️ untested |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | ⚠️ untested |
| `custom` | Custom | your own `baseURL` | `CUSTOM_API_KEY` | — |

`⚠️ untested` means the endpoint is a public OpenAI-compatible one, but this repo has never
sent a live request to it — verify before relying on it. For `Command Code`, keep its own
plugin and use **delegate mode**.

## Edit from the settings UI

The plugin ships a browser half registered into the `plugins.row.config` slot.

**Settings → Plugins → `WeNeed 适配器` → Configure**

| block | control | notes |
| --- | --- | --- |
| header | status dot | green = writable · amber = unsaved changes · red = save failed · grey = unavailable |
| Wiring | segmented | `Built-in channel` / `Delegate provider`; both wirings are configurable from the page |
| Channel | grouped dropdown | grouped as Verified / Public compatible endpoints / Custom; the channel's own address shows beneath |
| Base URL | text | appears only when the channel ships no address (`custom`, `commandcode`); required before saving |
| Key variable | text | placeholder follows the channel, e.g. `DEEPSEEK_API_KEY` for `deepseek` |
| Source provider | text | replaces the whole channel block in delegate mode; use an id from `ctx.llm.listProviders()` |
| Injection mode | segmented | `Inject seed` / `Pass through`; during passthrough the channel block dims and says so |
| Display name | text | live "Model picker will show: …" preview underneath |
| Debug log | toggle | one injection log line per request |

Saving writes straight through `form.mutate(ops, revision)` and takes effect right away. Edits are tracked and reversible. A failure distinguishes a concurrent revision conflict (refresh, then retry) from a generic write error (check the host log).

## Minimal config

```yaml
- insert:
    - id: weneed-adapter
      name: 'dsh-weneed-adapter'
      config:
        channel: opencode-go
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash (WeNeed)
            contextWindow: 1000000
```

Key resolution order: `config.apiKey` → env var named by `config.apiKeyEnv` →
same-named ref in `~/.dsh/.credentials.yaml`. Leave `apiKeyEnv` blank and the channel
preset supplies the variable name.

## Which requests get the seed

| request kind | seeded | audit reason |
| --- | --- | --- |
| first request of a new user turn | yes | `style-seed` |
| continuation after a tool call | no | `tool-step` |
| session title generation | no | `title-request` |
| context compaction summary | no | `compaction-request` |
| `mode: off` | no | `mode-off` |

## Self-test

```bash
node selftest.mjs        # offline, 9 structural assertions
node client-smoke.mjs    # offline, 13 render assertions for the browser half
node integration.mjs     # live gateway, 6 scenarios, needs a real key
node list-channels.mjs   # channel inventory
node --check index.js    # syntax
```

`integration.mjs` resolves the key from `OPENCODE_GO_API_KEY`, then
`DSH_CREDENTIALS_FILE`, then `~/.dsh/.credentials.yaml`.

## How it works

`llm/stream` hands over a deep-frozen request object (mutating it throws),
`agent/request` may not touch `messages`, and `agent/pre-step` can only land as a user
message. `LlmAdapter` is the one place that can read the old request and construct a new
one — built-in mode sends the HTTP call itself, delegate mode forwards to the original
adapter. Details in [docs/DETAIL.md](docs/DETAIL.md).

## License

MIT
