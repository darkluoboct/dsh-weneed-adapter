/**
 * 渠道预设表
 * ---------------------------------------------------------------------------
 * `verified: true` 表示端点来自本机真实配置或官方文档，且实测过；
 * `verified: false` 表示是 OpenAI 兼容约定的公开端点，但没在本机验证过 —— 用前请自己确认。
 *
 * 只写 baseURL / 协议 / key 的环境变量名，**不写任何密钥**。
 */

export const CHANNELS = [
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1',
    api: 'openai-completions',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    extraHeaders: { 'x-opencode-session': '' }, // 空串=自动生成，见 transport.js
    models: ['deepseek-v4.1-flash', 'minimax-m3.1-flash'],
    verified: true,
    note: '网关强制要求 x-opencode-session 头，缺了直接 400 MissingSessionID。',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1',
    api: 'openai-completions',
    apiKeyEnv: 'OPENCODE_API_KEY',
    models: ['deepseek-v4.1-flash', 'deepseek-v4-pro'],
    verified: true,
    note: '与 Go 同网关不同套餐；同样需要 x-opencode-session。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com',
    api: 'openai-completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    thinkingFormat: 'deepseek',
    verified: true,
    note: '带 tools 时必须回传历史 reasoning_content，否则 400。',
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    baseURL: '',
    api: 'openai-completions',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    models: ['deepseek/deepseek-v4.1-flash', 'zai-org/GLM-5.3', 'moonshotai/Kimi-K3'],
    verified: false,
    note: '端点由 @mars-sea/dsh-commandcode-provider 插件内置，未在本机核实；请先保留该插件并用「委托模式」。',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    apiKeyEnv: 'ZHIPU_API_KEY',
    models: ['glm-4.6', 'glm-4.5-flash'],
    verified: false,
    note: 'OpenAI 兼容路径。',
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    models: ['kimi-k2-0905-preview', 'moonshot-v1-128k'],
    verified: false,
  },
  {
    id: 'dashscope',
    name: '阿里云通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    models: ['qwen3-max', 'qwen-plus'],
    verified: false,
    note: '必须走 compatible-mode 路径才是 OpenAI 格式。',
  },
  {
    id: 'volces',
    name: '火山方舟（豆包）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
    apiKeyEnv: 'ARK_API_KEY',
    models: ['doubao-seed-1-6-250615'],
    verified: false,
    note: '模型 id 通常是推理接入点或模型名，按控制台填写。',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseURL: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
    apiKeyEnv: 'SILICONFLOW_API_KEY',
    models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3-235B-A22B-Instruct-2507'],
    verified: false,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseURL: 'https://api.minimax.chat/v1',
    api: 'openai-completions',
    apiKeyEnv: 'MINIMAX_API_KEY',
    models: ['MiniMax-M2'],
    verified: false,
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    api: 'openai-completions',
    apiKeyEnv: 'HUNYUAN_API_KEY',
    models: ['hunyuan-turbos-latest'],
    verified: false,
  },
  {
    id: 'qianfan',
    name: '百度千帆',
    baseURL: 'https://qianfan.baidubce.com/v2',
    api: 'openai-completions',
    apiKeyEnv: 'QIANFAN_API_KEY',
    models: ['ernie-4.5-turbo-128k'],
    verified: false,
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    baseURL: 'https://api.stepfun.com/v1',
    api: 'openai-completions',
    apiKeyEnv: 'STEPFUN_API_KEY',
    models: ['step-2-16k'],
    verified: false,
  },
  {
    id: 'lingyi',
    name: '零一万物',
    baseURL: 'https://api.lingyiwanwu.com/v1',
    api: 'openai-completions',
    apiKeyEnv: 'LINGYI_API_KEY',
    models: ['yi-lightning'],
    verified: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: ['deepseek/deepseek-chat-v3.1', 'anthropic/claude-sonnet-4.5'],
    verified: false,
  },
  {
    id: 'custom',
    name: '自定义（自己填 baseURL）',
    baseURL: '',
    api: 'openai-completions',
    apiKeyEnv: 'CUSTOM_API_KEY',
    models: [],
    verified: true,
    note: '在 config 里写 baseURL / apiKeyEnv / models 覆盖。',
  },
];

export function findChannel(id) {
  if (!id) return undefined;
  const key = String(id).trim().toLowerCase();
  return CHANNELS.find((c) => c.id.toLowerCase() === key)
    || CHANNELS.find((c) => c.name.toLowerCase() === key);
}

export function channelIds() {
  return CHANNELS.map((c) => c.id);
}
