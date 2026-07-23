# agent-code

`agent-code` 是《从零构建 Coding Agent CLI》实战教程的伴随项目。

当前章节：第 17 章。

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
node dist/cli/bin.js --help
```

确定性的完整 MVP 验收：

```bash
npm run test:mvp
```

普通测试不访问模型 API，也不需要 API key。

交互模式（不会自动读取 `.env.local`）：

```bash
OPENAI_API_KEY=... node dist/cli/bin.js chat --provider openai --model gpt-5.6-sol
# 或
DEEPSEEK_API_KEY=... node dist/cli/bin.js chat --provider deepseek --model deepseek-v4-pro
```

也可以把 Provider 和模型集中写入 `~/.agent-code/config.json`：

```json
{
  "provider": "openai",
  "models": {
    "openai": "gpt-5.6-sol",
    "deepseek": "deepseek-v4-pro"
  },
  "trustedWorkspaces": ["/absolute/path/to/project"]
}
```

配置完成后可直接运行 `node dist/cli/bin.js chat`。

OpenAI 官方当前建议复杂推理和编码任务使用 `gpt-5.6-sol`；`gpt-5.6`
是指向 Sol 的滚动别名。教程使用完整 model ID，便于明确记录 Session
实际选择的模型层级。

DeepSeek 官方将于 2026-07-24 15:59 UTC 停用旧的
`deepseek-chat` / `deepseek-reasoner` 模型名，因此教程当前版本统一使用
`deepseek-v4-pro`。Provider 类名中的 `Chat` 指 Chat Completions API，不是旧模型名。

优先级为 CLI、`AGENT_CODE_*` 环境变量、local、project、user、managed、默认值。project/local 仅在 workspace 已由 managed/user 配置显式信任后读取；项目 allow 不能覆盖 managed deny。完整字段和合并规则见[第 17 章](../docs/chapters/17-configuration-policy-hierarchy.md)。API key 仍只使用 `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`，不会写入配置或 Session。

会话会默认保存到 `~/.agent-code/sessions`：

```bash
node dist/cli/bin.js --resume <session-id>
node dist/cli/bin.js --fork-session <session-id>
node dist/cli/bin.js session export <session-id>
```

可使用 `--session-dir <path>` 或 `AGENT_CODE_SESSION_DIR` 覆盖保存位置。Session 只记录 Provider/模型名称，不保存 API key。

上下文会加载 `~/.agent-code/AGENTS.md`、项目根 `AGENTS.md` 和当前活跃路径祖先目录中的嵌套 `AGENTS.md`。交互中使用 `/context` 查看基础提示、指令、工具 schema、摘要和近期对话的估算占用；压缩不会删除 Session 的完整历史。

显式使用 `.env.local` 运行真实 Provider 的完整 smoke test：

```bash
npm run test:mvp:live:local -- openai
npm run test:mvp:live:local -- deepseek
```
