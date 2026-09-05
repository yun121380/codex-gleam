# 参与开发

## 环境

Node.js 20 以上、pnpm。pnpm 的版本写在 `package.json` 的 `packageManager` 字段里，
`corepack` 或 CI 都从那里读，不用另外指定。

```bash
pnpm install
pnpm dev
```

## 提 PR 之前

```bash
pnpm verify
```

它等于 `typecheck` + `lint` + `test`。CI 会在 windows / macos / ubuntu 三个平台上各跑一遍同样的命令，三个都必须绿。

## 三条不能破的底线

本项目有一批用测试锁住的约束，`tests/security/offline.test.ts` 会扫描 `src/` 下的全部源码：

1. **不引入网络能力**：`fetch`、`XMLHttpRequest`、`new WebSocket`、`EventSource`、`sendBeacon`、`http` / `https` 模块、自动更新库，一个都不能出现在 `src/` 下。
2. **不引入执行能力**：`child_process`、`spawn(`、`execFile(` 不能出现在 `src/` 下。构建期脚本放 `scripts/`，不在扫描范围内 —— 那些脚本只在打包时跑，不进运行时。
3. **不改写用户的原始会话文件**：文件系统访问只读。

如果你的功能看起来必须破其中一条，那大概是设计问题，先开 issue 讨论。

## 提交信息

用 `type(scope): summary` 格式，例如 `feat(search): add inverted index`。
