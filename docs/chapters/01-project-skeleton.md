# 第 1 章：项目骨架和章节契约

本章不急着连接模型。我们先建立一条以后每章都不能破坏的工程基线：源码可编译、测试可重复、发布产物能执行，而且失败会给用户清楚的退出码。

对应代码快照：`chapter-01`。

## 1. 本章问题

原理教程中的代码片段来自不同语言和不同阶段。如果直接继续堆功能，我们无法判断一个错误来自 Agent 设计，还是来自缺失的构建配置。第一步因此是把“可运行”变成自动检查的契约。

## 2. 行为规格

本章结束后，用户能观察到：

```bash
$ agent-code --help
agent-code 0.1.0

Usage:
  agent-code [options]

$ agent-code --unknown
Unknown argument: --unknown
# exit code: 2
```

Node.js 版本低于 22 时，CLI 在做任何工作前返回可读错误。空参数暂时显示帮助；第 9 章会把它升级成交互会话。

## 3. 威胁和失败模型

本章处理：

- 不受支持的 Node.js 版本。
- 无法识别的命令行参数。
- CLI 顶层出现未捕获异常。
- 源码能跑但发布后的 `dist/` 不能跑。

本章还不处理模型密钥、文件权限、Shell 隔离或工作区信任。这些能力尚未实现，文档不会把空壳称为安全机制。

## 4. 接口设计

CLI 核心函数不直接调用 `process.exit()`：

```ts
function main(
  args: readonly string[],
  io: CliIO,
  environment: CliEnvironment,
): number;
```

它返回退出码，并把 IO 与 Node 版本作为边界传入。这样单元测试不用修改全局进程；真正的 `bin.ts` 只负责接线。

退出码约定：

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令成功 |
| `1` | 运行环境或内部错误 |
| `2` | CLI 用法错误 |

## 5. 完整实现

源码都在 `agent-code/`。关键目录是：

```text
agent-code/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── src/
│   ├── version.ts
│   └── cli/
│       ├── bin.ts
│       └── main.ts
├── tests/
│   ├── unit/cli-main.test.ts
│   └── e2e/cli.test.ts
├── examples/fixture-project/
└── docs/adr/0001-use-typescript.md
```

`package.json` 把开发检查和最终构建分开。`typecheck` 不产生文件，`build` 只编译 `src/`，`test:e2e` 则先构建再启动真实的 `dist/cli/bin.js`。

`src/cli/main.ts` 完成三件事：先检查 Node.js 版本，再识别帮助/版本参数，最后拒绝未知参数。`src/cli/bin.ts` 保留 shebang，并把未预期异常转换成退出码 1。

完整实现不在文档中维护第二份副本，请直接查看这些真实文件：

- [`package.json`](../../agent-code/package.json)
- [`src/cli/main.ts`](../../agent-code/src/cli/main.ts)
- [`src/cli/bin.ts`](../../agent-code/src/cli/bin.ts)
- [`tests/unit/cli-main.test.ts`](../../agent-code/tests/unit/cli-main.test.ts)
- [`tests/e2e/cli.test.ts`](../../agent-code/tests/e2e/cli.test.ts)

这样修复代码时不会忘记同步一段已经过时的教程代码。

## 6. 从空目录迁移

在仓库根目录执行：

```bash
cd agent-code
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e
```

全仓库使用一个章节 tag。完成本章后：

```bash
git add .
git commit -m "chapter 01: scaffold the TypeScript CLI"
git tag -a chapter-01 -m "Chapter 01: project skeleton"
```

后续章节必须在前一章测试通过的基础上继续，不能重建一个不相干的新项目。

## 7. 测试

单元测试覆盖纯逻辑：

- Node 22/24 被接受。
- Node 20 和非法版本字符串被拒绝。
- `--help` 返回 0。
- 未知参数返回 2。

端到端测试覆盖发布产物：它用当前 Node 进程启动 `dist/cli/bin.js`，检查 stdout、stderr 和真实退出码。这能发现 shebang、ESM 路径和 build 输出目录接错的问题。

CI 名为 `mock-only`。它不读取 `OPENAI_API_KEY` 或 `DEEPSEEK_API_KEY`，因为真实 Provider 到第 4 章才出现。

## 8. 动手实验

把 `package.json` 中的 bin 路径临时改成 `dist/bin.js`，再运行：

```bash
npm run test:e2e
```

观察测试如何在发布入口错误时失败。实验后恢复文件。然后把测试中的模拟版本改成 `20.0.0`，确认版本错误在参数解析前出现。

## 9. 完成检查

以下命令必须全部成功：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
node dist/cli/bin.js --help
```

还要人工检查未知参数的退出码：

```bash
node dist/cli/bin.js --unknown
echo $?
# 预期：2
```

## 10. 下一章留下的问题

CLI 现在只有外壳。下一章会定义厂商无关的消息块和运行时事件，并为它们加入版本化 JSON 序列化。只有协议先稳定，GPT、DeepSeek、终端渲染器和未来的 JSONL 输出才不会互相绑死。
