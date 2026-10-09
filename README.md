# Dev Tracker

供使用 AI 开发的用户查看任务、实际改动和验证依据的本地开发地图。采用 JavaScript / Node.js + Electron，交付 Windows 桌面程序，通过 MCP 接入开发 AI。

当前稳定版本：**0.11.0**。独立 Windows 验收步骤见[WINDOWS_ACCEPTANCE.md](WINDOWS_ACCEPTANCE.md)。顶部显示程序版本和当前项目实际收到的MCP调用；空闲时的最近成功不代表持续在线。

## 使用

从 GitHub Releases 下载 `Dev Tracker Setup <版本>.exe`。安装包未签名，Windows 可能提示未知发布者。打开程序后选择项目目录；首次扫描建立基线，之后记录扫描范围内的文件变化和 Git 状态。

记录位于 Windows 应用数据目录的 `dev-tracker` 文件夹，各项目独立保存。关闭后重新选择同一目录可继续读取。备份按钮导出全部 Tracker 记录；恢复按钮全量替换记录并重启。备份**不包含项目源码、依赖和并行副本代码**，但包含本机路径、需求与测试输出，请自行保管。

诊断导出保存本次运行最近 200 条启动、监听和 MCP HTTP 结果等事件，不记录项目正文或请求内容。它不能直接捕获 AI 客户端的 TCP 错误；故障时仍需保留客户端原始报错。

## MCP 接入

推荐使用命名管道 stdio 桥。先打开桌面程序，再连接 MCP；桥与桌面共用记录，不创建第二套存储。安装版使用自带的 Electron 运行时，无需另装 Node.js。

下面用 Windows 用户 `YourName`、默认安装目录举例；请将用户名和安装目录替换成实际绝对路径。发现文件实际位于 `%APPDATA%/dev-tracker/mcp-connection/discovery.json`，TOML 中使用展开后的绝对路径。发现文件含本次运行凭据，不要复制、上传或导出其内容。

```toml
[mcp_servers.dev_tracker]
command = 'C:\Users\YourName\AppData\Local\Programs\Dev Tracker\Dev Tracker.exe'
args = ['C:\Users\YourName\AppData\Local\Programs\Dev Tracker\resources\app.asar\mcp-stdio.mjs', '--config', 'C:\Users\YourName\AppData\Roaming\dev-tracker\mcp-connection\discovery.json']
env = { ELECTRON_RUN_AS_NODE = "1" }
```

Codex stdio 的 `command`、`args` 和 `env` 字段依据 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)。桌面重启会更换管道和凭据，随后需重新启动 MCP 桥。GUI 模式的 `--mcp-stdio` 不能作为 Windows stdio 启动方式；请保留上面的运行时环境变量。

管道凭据文件使用当前用户 ACL，请求使用 Bearer token；这不等于验证了原生命名管道 ACL 或跨用户安全隔离。旧版 HTTP 接口仍可选，客户端需支持 Streamable HTTP；只监听本机，端口占用时明确失败。它仍受尚未确定根因的历史 TCP 建连故障影响。

```toml
[mcp_servers.dev_tracker]
url = "http://127.0.0.1:4318/mcp"
```

每个开发会话首先调用 `bind_session`，提供实际 `projectRoot` 和会话 `label`。保留返回的 `sessionId`，每次中央 MCP 调用均携带该身份。续接先 `get_handoff` 核对目录、任务和证据，再按节点或关键词 `get_journal`；重要步骤后 `append_journal` 记录做法、验证范围、坑和下一步。

工具：`bind_session`、`get_map`、`get_node`、`update_node`、`get_evidence`、`get_diff`、`link_evidence`、`run_tests`、`get_handoff`、`get_overview`、`append_journal`、`get_journal`。

多个会话需要独立身份，同时改代码请使用独立目录或并行副本。会话身份不能隔离真实代码。Git 副本要求已有提交且工作区干净，不自动合并。

## 能力边界

- 文件/Git 追踪不限项目语言；自动测试目前仅运行扫描范围内的 Node.js 测试，会执行项目代码。
- 排除 `.git`、`node_modules`、`dist`、`.data`、`.demo`、`test-results`、当前记录目录及符号链接；版本依据仅覆盖此范围。
- AI 自报、观察改动、执行测试与用户验收分别保留；亮线依据任务状态，不能证明实际文件操作。测试前后扫描一致不能证明中途没有修改。
- 精简交接提供按需读取，不保证 AI 遵循续接，也未测量幻觉或费用降低。
- 历史偶发 TCP 超时具体根因仍未明。

## 源码开发

需要 Node.js 22 或更新版本及 Git；Windows x64 打包需 Windows 环境。

```powershell
npm.cmd ci
npm.cmd run desktop
npm.cmd run test:core
npm.cmd run test:pipes
npm.cmd run test:desktop:all
.\node_modules\.bin\electron-builder.cmd --win nsis --x64 --config.directories.output=dist/0.11.0
node scripts/release-check.mjs
```

`npm.cmd start` 启动本机网页界面，默认端口 4317。桌面文件选择、备份恢复和诊断导出需要 Electron。测试使用独立临时记录；打包桌面检查通过 `DEV_TRACKER_EXE` 指定可执行文件。

许可证：MIT。
