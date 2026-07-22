# ADR-0001：实战篇统一使用 TypeScript

- 状态：Accepted
- 日期：2026-07-22

## 背景

原理教程前半段使用 Python，产品章节又切换到 TypeScript，读者无法把后半段代码直接接到前面的 Harness 上。

## 决定

伴随项目统一使用 TypeScript、Node.js 22+、ESM 和严格类型检查。Provider、运行时、工具、CLI 和测试都使用同一套类型。

## 结果

- 每章只维护一条可编译链路。
- Node.js 原生异步迭代器、AbortSignal 和子进程 API 可以贯穿模型流与工具执行。
- Python 章节继续作为原理参考，但不复制进伴随项目。
- Node.js 22 成为明确的运行门槛，CLI 需要在启动时给出可读错误。
