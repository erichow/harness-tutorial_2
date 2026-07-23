# agent-code

`agent-code` 是《从零构建 Coding Agent CLI》实战教程的伴随项目。

当前章节：第 15 章。

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
OPENAI_API_KEY=... node dist/cli/bin.js chat --provider openai --model gpt-5
# 或
DEEPSEEK_API_KEY=... node dist/cli/bin.js chat --provider deepseek --model deepseek-chat
```

会话会默认保存到 `~/.agent-code/sessions`：

```bash
node dist/cli/bin.js --resume <session-id>
node dist/cli/bin.js --fork-session <session-id>
node dist/cli/bin.js session export <session-id>
```

可使用 `--session-dir <path>` 或 `AGENT_CODE_SESSION_DIR` 覆盖保存位置。Session 只记录 Provider/模型名称，不保存 API key。

显式使用 `.env.local` 运行真实 Provider 的完整 smoke test：

```bash
npm run test:mvp:live:local -- openai
npm run test:mvp:live:local -- deepseek
```
