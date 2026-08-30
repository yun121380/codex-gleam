# 拾光 Gleam v1.0.0

> 完全离线的本地 Codex 会话查看器。无需登录、无需 API Key，不会上传数据，也不会执行日志里的命令。

![会话时间线](https://raw.githubusercontent.com/yun121380/codex-gleam/main/docs/screenshots/02-sessions.png)

## 中文

### 首个公开版本

拾光会自动查找本机常见位置中的 Codex JSON/JSONL 会话，把原始日志整理成易读的三栏时间线，让你快速看清：

- 你向 Codex 提出了什么要求；
- Codex 执行了哪些命令；
- 哪些文件被读取或修改；
- 测试通过、失败或跳过了多少；
- 哪一步发生错误以及对应输出。

### 主要功能

- 自动发现 Windows 上常见的 Codex 会话目录；
- 支持 JSON、JSONL、Codex Desktop rollout、工具调用、命令输出、补丁和测试结果；
- 支持会话搜索、筛选、播放、失败定位和代码差异查看；
- 自动折叠并行子代理会话；
- 提供完全本地、确定性的使用统计；
- 支持导出 Markdown、静态 HTML 和标准化 JSON；
- 默认隐藏用户主目录并自动打码密钥、Token、密码、Cookie 和私钥；
- 不联网、不调用任何 AI API、不执行日志里的命令。

![测试结果](https://raw.githubusercontent.com/yun121380/codex-gleam/main/docs/screenshots/03-test.png)

![敏感信息打码](https://raw.githubusercontent.com/yun121380/codex-gleam/main/docs/screenshots/04-redaction.png)

### 下载

- `Gleam-Setup-1.0.0-x64.exe`：Windows x64 安装版；
- `Gleam-1.0.0-x64-portable.zip`：Windows x64 免安装版；
- `SHA256SUMS.txt`：发布文件 SHA-256 校验值。

### 系统要求

- Windows 11 x64（已实机验证）；
- Windows 10 x64 预计可用，但尚未完成完整验证。

---

## English

### First public release

Gleam automatically discovers Codex JSON/JSONL sessions in common local locations and turns raw logs into a readable three-panel timeline. It helps you understand:

- what you asked Codex to do;
- which commands Codex ran;
- which files were read or changed;
- how many tests passed, failed, or were skipped;
- where an error occurred and what the command printed.

### Highlights

- Automatically discovers common Codex session directories on Windows.
- Supports JSON, JSONL, Codex Desktop rollouts, tool calls, command output, patches, and test results.
- Provides search, filtering, playback, failure navigation, and code diff views.
- Groups parallel sub-agent sessions under their parent session.
- Computes deterministic local statistics without a model or network connection.
- Exports Markdown, fully offline HTML, and normalized JSON reports.
- Hides the user home directory and redacts keys, tokens, passwords, cookies, and private keys by default.
- Does not connect to cloud services, call AI APIs, or execute commands from logs.

![Local statistics](https://raw.githubusercontent.com/yun121380/codex-gleam/main/docs/screenshots/05-stats.png)

![Offline export](https://raw.githubusercontent.com/yun121380/codex-gleam/main/docs/screenshots/06-export.png)

### Downloads

- `Gleam-Setup-1.0.0-x64.exe` — Windows x64 installer;
- `Gleam-1.0.0-x64-portable.zip` — portable Windows x64 build;
- `SHA256SUMS.txt` — SHA-256 checksums for the release files.

### Requirements

- Windows 11 x64 is verified.
- Windows 10 x64 is expected to work but has not completed full validation.

## Verification

The source release passes TypeScript checks, ESLint, 462 automated tests, and the production build.
