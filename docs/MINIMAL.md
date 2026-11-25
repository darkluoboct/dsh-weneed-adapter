# 通用配置模板（给"别人"用）
#
# 装了本插件后，模型选择器里会多出一个 provider，显示名默认 `[WeNeed] <sourceProvider>`。
# 它不会自动变成 "OpenCode WeNeed" —— 名字取决于你填的 sourceProvider。
#
# 最小配置：只改 sourceProvider 这一行。
#   插件会自动继承该 provider 的模型列表（名字加 (WeNeed) 后缀），
#   所以别人不需要手写 models。

- insert:
    - id: weneed-adapter
      name: 'dsh-weneed-adapter'
      config:
        # ← 唯一必填：你要给哪个 provider 加 WeNeed（用 ctx.llm.listProviders() 里的 id）
        sourceProvider: opencode-go
