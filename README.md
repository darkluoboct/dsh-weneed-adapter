# dsh-weneed-adapter

A DeepSeek Harness plugin that injects a **WeNeed register seed** into model requests.
No proxy process, no port, no config surgery — it starts and stops with DSH.

让模型保持在 `We need / Need / We should` 的集体规划语态，而不是滑回 `Let me / The user wants me to`。

[English](README.en.md)

## 安装

插件以 **bundle** 形式挂进 DSH。四步，全程不碰 DSH 源码。

### 1. 拿到代码

```bash
git clone https://github.com/darkluoboct/dsh-weneed-adapter.git
```

### 2. 在 profile 里登记

编辑 `~/.dsh/profiles/<profile>/package.json`（Windows 是 `C:\Users\<你>\.dsh\profiles\<profile>\package.json`）：

```json
{
  "private": true,
  "dependencies": {
    "dsh-weneed-adapter": "link:/绝对路径/dsh-weneed-adapter"
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

`dependencies` 里也可以直接写 `"dsh-weneed-adapter": "github:darkluoboct/dsh-weneed-adapter"`，跳过 clone。

### 3. 装依赖并重启

```bash
cd ~/.dsh/profiles/<profile>
pnpm install
```

重启 DSH。插件跟着宿主启停，**不需要**单独跑进程、不占端口。

### 4. 填配置

在同一目录的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: weneed-adapter
      name: 'dsh-weneed-adapter'
      config:
        channel: deepseek     # 换渠道只改这一行
        mode: always
```

> home 层 `~/.dsh/cordis.patch.yml` 只放 `insert`，`config` 写在 profile 层——否则会盖掉设置页的编辑结果，改配置时 UI 会报 `overridden by a home patch`。

装完模型选择器里会多出一个分组，选它即用；`mode: off` 是纯透传，随时回滚。

## 两种工作模式

| 模式 | 配置 | 说明 |
| --- | --- | --- |
| **A 内置渠道**（推荐） | `channel: opencode-go` | 插件自己发请求。玩家只填渠道 + 密钥，**不需要 DSH 里已有对应 provider**。 |
| **B 委托** | `sourceProvider: opencode-go` | 把请求转交给 DSH 里已注册的 provider。适合该渠道已由别的插件配好的情况。 |

两种模式都能在设置页的「工作方式」里一键切换，手改 `cordis.patch.yml` 是另一条等价入口。

## 内置渠道

```powershell
node list-channels.mjs          # 列出全部
node list-channels.mjs 国内      # 按关键词过滤
```

| channel id | 名称 | baseURL | 密钥环境变量 | 已验证 |
| --- | --- | --- | --- | --- |
| `opencode-go` | OpenCode Go | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` | ✅ 实测 |
| `opencode-zen` | OpenCode Zen | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY` | ✅ 配置确认 |
| `deepseek` | DeepSeek 官方 | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | ✅ 文档确认 |
| `commandcode` | Command Code | *需自填* | `COMMANDCODE_API_KEY` | ⚠️ 见备注 |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | ⚠️ 未验证 |
| `moonshot` | 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | ⚠️ 未验证 |
| `dashscope` | 阿里云通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | ⚠️ 未验证 |
| `volces` | 火山方舟（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` | ⚠️ 未验证 |
| `siliconflow` | 硅基流动 | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | ⚠️ 未验证 |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` | `MINIMAX_API_KEY` | ⚠️ 未验证 |
| `hunyuan` | 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `HUNYUAN_API_KEY` | ⚠️ 未验证 |
| `qianfan` | 百度千帆 | `https://qianfan.baidubce.com/v2` | `QIANFAN_API_KEY` | ⚠️ 未验证 |
| `stepfun` | 阶跃星辰 | `https://api.stepfun.com/v1` | `STEPFUN_API_KEY` | ⚠️ 未验证 |
| `lingyi` | 零一万物 | `https://api.lingyiwanwu.com/v1` | `LINGYI_API_KEY` | ⚠️ 未验证 |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | ⚠️ 未验证 |
| `custom` | 自定义 | 自己填 `baseURL` | `CUSTOM_API_KEY` | — |

`⚠️ 未验证` = 公开 OpenAI 兼容端点，但本机没打通验证过，用前请自己确认。
`Command Code` 的端点由它自己的插件内置，本仓库没核实，建议保留原插件并用**委托模式**。

## 在设置里改（不用编辑文件）

插件带浏览器半边，注册到设置页的 `plugins.row.config` slot。

**入口：设置 → 插件 → `WeNeed 适配器` → 「配置」**

页面自上而下：

| 区块 | 控件 | 说明 |
| --- | --- | --- |
| 标题行 | 状态点 | 绿=可写 · 黄=有未保存改动 · 红=保存失败 · 灰=不可用 |
| 工作方式 | 分段按钮 | `内置渠道` / `委托 provider`，两种接法都能在页面上配完 |
| 渠道 | 分组下拉 | 分「已实测 / 公开兼容端点 / 自定义」三组，选中后下方显示它自带的地址 |
| Base URL | 文本框 | 只在渠道自带地址为空时出现（`custom`、`commandcode`），空着存不下去 |
| 密钥变量名 | 文本框 | placeholder 跟着渠道走：选 `deepseek` 就提示 `DEEPSEEK_API_KEY` |
| 源 provider | 文本框 | 委托模式下顶替整个渠道区，填 `ctx.llm.listProviders()` 里的 id |
| 注入模式 | 分段按钮 | `注入 seed` / `纯透传`；透传时渠道区降透明度，提示当前暂停生效 |
| 显示名 | 文本框 | 下方实时预览「模型选择器将显示：…」 |
| 调试日志 | 开关 | 每条请求打一行注入日志 |

保存走 `form.mutate(ops, revision)` 直写 Host 配置，改完即生效。改动可感知，按「撤销」回到已保存状态。保存失败分两种提示：配置刚被别处改过（刷新后重试），或一般写失败（看 Host 日志）。

> 那一行只显示「启用/禁用」时，说明浏览器半边还没加载——刷新一次页面。

## 最小配置（也可以直接改文件）

```yaml
- insert:
    - id: weneed-adapter
      name: 'dsh-weneed-adapter'
      config:
        channel: opencode-go          # ← 换渠道只改这一行
        models:
          - id: deepseek-v4.1-flash   # ← 模型 id 按渠道填
            name: DeepSeek V4.1 Flash (WeNeed)
            contextWindow: 1000000
```

密钥解析顺序：`config.apiKey` → 环境变量 `config.apiKeyEnv` → `~/.dsh/.credentials.yaml` 里同名 ref。
不写 `apiKeyEnv` 就用渠道预设里的默认变量名。

## 哪些请求会被注入

| 请求类型 | 注入 | 审计 reason |
| --- | --- | --- |
| 新用户轮首个请求 | 是 | `style-seed` |
| 工具调用后的续跑 | 否 | `tool-step` |
| 生成会话标题 | 否 | `title-request` |
| 上下文压缩摘要 | 否 | `compaction-request` |
| `mode: off` | 否 | `mode-off` |

## 自检

```powershell
node selftest.mjs        # 不出网，9 条结构断言
node client-smoke.mjs    # 不出网，浏览器半边渲染 13 条断言
node integration.mjs     # 真机打网关，6 个场景
node list-channels.mjs   # 渠道清单
node --check index.js    # 语法
```

## 实现要点

DSH 的 `llm/stream` waterfall 请求对象 deep-frozen（`mutation throws`），
`agent/request` 不能改 messages，`agent/pre-step` 只能落成 user 消息。
唯独 `LlmAdapter` 可以「读旧请求、造新请求」——内置模式自己发 HTTP，委托模式转交原适配器。
详见 [docs/DETAIL.md](docs/DETAIL.md)。

## License

MIT
