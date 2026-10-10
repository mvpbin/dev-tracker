# Dev Tracker

**给不会代码、但用 Codex 开发软件的人，一张看得懂、能核对的开发地图。**

Dev Tracker 是配合 Codex 使用的本地开发管理工具。你继续用大白话向 AI 提需求，AI 负责写代码；Dev Tracker 把功能任务、实际改动、测试结果和会话交接集中保存，呈现在横向思维导图和任务板中。用户无需操作 VS Code，也无需先读懂代码目录才能指出想改的功能。

它帮助你回答三个问题：**正在做什么、实际改了什么、凭什么说做完了。**

[下载 Windows 版](https://github.com/mvpbin/dev-tracker/releases/tag/v0.12.0) · [本版更新](RELEASE_NOTES_0.12.0.md) · [Windows 验收清单](WINDOWS_ACCEPTANCE.md)

[试用 0.12.1-rc.3 候选版](https://github.com/mvpbin/dev-tracker/releases/tag/v0.12.1-rc.3)：中央工作区默认全宽，点“任务与详情”或功能节点展开右侧面板；顶部可直接打开 / 切换项目。本版也修复大型项目构建缓存造成的扫描长等待。候选版尚未重验独立 Windows 安装，正式稳定版仍为 0.12.0。

## 为什么需要它

用 AI 做工具，能提出想法并不意味着能判断开发结果。尤其在功能增多、不断修改需求、聊天变长之后，你可能遇到这些问题：

| 你遇到的困扰 | Dev Tracker 提供的依据 |
| --- | --- |
| AI 忙了很久，我不知道它在做哪个功能 | 功能地图、当前任务播报、AI 报告的处理中分支 |
| 我想改某个功能，但不知道对应哪些代码 | 点选功能节点，用自然语言保存修改要求，并关联实际改动 |
| AI 说完成了，我不知道它到底改了什么 | 观察到的文件变化、Git 状态、当前代码差异，以及明确关联的功能节点 |
| 软件能运行，但这次修改是否验证过 | 实际测试结果、对应的扫描版本、验收步骤、AI 复核的范围和未覆盖内容 |
| 换了聊天，AI 忘记之前的要求和决定 | 持久保存的任务、当前决定、替代历史、未决问题、AI 开发笔记和交接 |
| 不知道还剩什么，是否已经够用 | 按本版交付清单展示进度、待办和下一行动者；未定义清单时不编造完成百分比 |

这些记录让开发过程更容易检查，也让下一次沟通有具体依据。它不能只凭 AI 的一句“完成了”替你判断质量。

## 适合谁

- **零基础或不熟悉代码的用户**：主要通过 Codex 对话制作个人工具或小项目，希望按功能和可见结果参与开发。
- **喜欢 vibe coding 的用户**：希望项目越做越大时，仍能分清当前要求、旧决定、改动和验证情况。
- **经常更换开发会话的用户**：希望新会话能读取保存的项目背景，而不是每次从头解释。
- **个人开发者**：希望给 AI 开发过程留记录，便于后续复查和交接。

## 一个具体例子

你让 Codex 做一个清单工具，后来提出：“导出时只保留筛选后的内容。”

在 Dev Tracker 中，这条要求可以保存在“导出”功能节点下。AI 获取完整要求后，节点显示获取回执；AI 可以把这次文件改动关联到节点，并保存测试结果、验收步骤和复核记录。你点开这个功能，就能查看修改依据，以及哪些内容还没有验证。

下次换 Codex 会话时，新会话可以先读取交接，再读取完整节点要求和当前决定，核对实际代码后继续工作。记录留在本机，不会因为关闭聊天或关闭 Tracker 就消失。

## 怎样配合 Codex 使用

1. 打开 Dev Tracker，选择实际开发项目目录，按功能建立横向地图。地图由你或 AI 维护，不会自动把所有代码变成正确的功能树。
2. 连接 MCP，告诉 Codex 在开发前读取任务和交接，开发后更新任务、关联实际变化并记录验证。
3. 在地图上选择功能、保存修改要求；在项目概览和任务播报中查看进度。保存要求不会自动唤醒或打断 Codex，需要让当前会话读取。
4. 按节点中的操作步骤和预期结果试用；换会话时点击“复制续接”，让新会话先核对记录再开发。

MCP 是让 Codex 读写这些记录的连接接口。Dev Tracker 不提供 AI 模型，也不替代 Codex 写代码；AI 是否遵循流程，仍取决于实际接入和操作。

## 记录和证明有区别

Dev Tracker 将 **AI 自报、观察到的改动、实际测试、用户确认** 分开记录：

- 分支亮线表示 AI 报告正在处理该任务，不是读取 AI 思考或实时捕获每一次代码操作。
- 完整要求的获取回执表示 AI 已取回要求，不代表它已经理解或执行。
- 文件变化可以被扫描发现，但归属于哪个功能需要明确关联；当前 Git 差异不是每次历史修改的完整快照。
- 测试和验收依据关联项目扫描版本；代码或要求变化后，旧结论可能需要重查。
- AI 笔记保存做法、原因、遇到的坑和下一步，便于按需回顾；笔记和 AI 复核本身仍是报告，不是执行证明。

它旨在减少开发过程不可见、记录散落和换会话信息遗漏的问题。**不保证消除幻觉、避免混乱代码或所有 BUG，也没有验证能降低 token 用量或中转站费用。**

## 下载与记录保存

当前稳定版本：**0.12.0**，Windows x64 桌面程序。使用安装包或免安装包无需另装 Node.js。

从 GitHub Releases 下载 `Dev.Tracker.Setup.0.12.0.exe` 安装版，或下载 `Dev-Tracker-0.12.0-win-x64.zip` 免安装版。免安装版需解压完整目录，再运行其中的 `Dev Tracker.exe`；项目记录仍保存在下述 Windows 应用数据目录，不随程序文件夹搬迁。程序未签名，Windows 可能提示未知发布者。升级或卸载前关闭所有Dev Tracker窗口，包括免安装版。打开程序后选择项目目录；首次扫描建立基线，之后记录扫描范围内的文件变化和 Git 状态。

记录位于 Windows 应用数据目录的 `dev-tracker` 文件夹，各项目独立保存。关闭后重新选择同一目录可继续读取。备份按钮导出全部 Tracker 记录；恢复按钮全量替换记录并重启。备份**不包含项目源码、依赖和并行副本代码**，但包含本机路径、需求与测试输出，请自行保管。

诊断导出保存本次运行最近 200 条启动、监听和 MCP HTTP 结果等事件，不记录项目正文或请求内容。它不能直接捕获 AI 客户端的 TCP 错误；故障时仍需保留客户端原始报错。

## MCP 接入

推荐使用命名管道 stdio 桥。先打开桌面程序，再连接 MCP；桥与桌面共用记录，不创建第二套存储。安装版使用自带的 Electron 运行时，无需另装 Node.js。

侧栏“复制 MCP 配置”会生成本机的程序与发现文件路径；把配置交给 Codex 配置流程使用。复制不修改 Codex 配置，也不唤醒聊天。保存要求只写入本地；get_node 获取完整要求后显示回执，不代表 AI 已理解或执行。get_decisions 分页读取完整当前决定，直到 nextOffset 为 null；history 查看替代记录。set_acceptance_plan 保存操作/预期结果，record_quality_review 保存检查范围/发现/限制，均不自动确认验收。需求、步骤、条件、决定、目标或扫描版本改变时，复核需重查；历史复核保留在 get_journal。

下面用 Windows 用户 `YourName`、默认安装目录举例；请将用户名和安装目录替换成实际绝对路径。免安装版将 `command` 和 `args` 中的程序路径改为实际解压目录；发现文件仍位于 `%APPDATA%/dev-tracker/mcp-connection/discovery.json`，TOML 中使用展开后的绝对路径。发现文件含本次运行凭据，不要复制、上传或导出其内容。

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

工具：`bind_session`、`get_map`、`get_node`、`update_node`、`get_evidence`、`get_diff`、`link_evidence`、`run_tests`、`get_handoff`、`get_overview`、`append_journal`、`get_journal`、`record_decision`、`get_decisions`、`set_acceptance_plan`、`record_quality_review`。

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
.\node_modules\.bin\electron-builder.cmd --win nsis --x64 --config.directories.output=dist/0.12.0
node scripts/release-check.mjs
```

`npm.cmd start` 启动本机网页界面，默认端口 4317。桌面文件选择、备份恢复和诊断导出需要 Electron。测试使用独立临时记录；打包桌面检查通过 `DEV_TRACKER_EXE` 指定可执行文件。

许可证：MIT。
