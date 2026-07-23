# Harness Tutorial：Coding Agent CLI 实战

这个仓库包含两部分内容：

- `part1-harness.html`、`part2-product.html` 和 `tutorial_content/`：原有原理教程。
- `PRACTICAL_TUTORIAL.md`、`docs/chapters/` 和 `agent-code/`：连续、可运行的 TypeScript 实战教程。

实战项目按章节保留 Git 快照：

```text
chapter-01 ... chapter-23
```

检出任意 tag 后，都应能在 `agent-code/` 中运行该章列出的验收命令。

## 当前进度

- [x] 第 1 章：项目骨架和章节契约
- [x] 第 2 章：类型化消息和事件协议
- [x] 第 3 章：Mock Provider 和最小 Agent Loop
- [x] 第 4 章：GPT / DeepSeek Provider 和流式工具调用
- [x] 第 5 章：Tool Registry、Schema 和结果信封
- [x] 第 6 章：项目发现、读取、搜索和 Patch 编辑
- [x] 第 7 章：可取消的 Shell 执行器
- [x] 第 8 章：Workspace Trust、权限与沙箱
- [x] 第 9 章：CLI 交互、事件渲染和取消
- [x] 第 10 章：MVP 端到端验收
- [x] 第 11 章：真实 Diff、并发冲突和变更归属
- [x] 第 12 章：Checkpoint 和 Undo
- [x] 第 13 章：Git 工具和用户修改保护
- [x] 第 14 章：测试—诊断—修复循环
- [x] 第 15 章：Session 持久化、恢复和分支
- [x] 第 16 章：上下文预算、压缩和项目指令
- [x] 第 17 章：配置系统和策略层级
- [x] 第 18 章：Headless 和 JSONL 协议
- [x] 第 19 章：MCP、Hooks 和 Skills
- [x] 第 20 章：可观测性和工作流 Eval

其余章节见 [实战教程设计稿](./PRACTICAL_TUTORIAL.md)。
