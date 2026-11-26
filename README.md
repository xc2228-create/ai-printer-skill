# printer-skill · 让 AI 助手一句话就能打印

> **一句话说明**：这是一个 Windows 命令行工具 + MCP 服务，让 AI 助手（Claude、Cursor、DSH、WorkBuddy、任何能执行命令的 agent）
> 用**一条命令**完成打印——文件、一段文字、网页、图片、PDF、Word、Excel 都行。
> 不弹窗、不点鼠标、不经过打印预览、不依赖系统默认打印机。

<p>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933">
  <img alt="deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
  <img alt="stars" src="https://img.shields.io/github/stars/xc2228-create/ai-printer-skill?style=flat">
  <img alt="downloads" src="https://img.shields.io/github/downloads/xc2228-create/ai-printer-skill/total">
  <img alt="issues" src="https://img.shields.io/github/issues/xc2228-create/ai-printer-skill">
</p>

---

## 目录

- [这是什么](#这是什么)
- [30 秒上手](#30-秒上手)
- [为什么需要它](#为什么需要它)
- [功能一览](#功能一览)
- [使用说明](#使用说明)
- [给 AI 接入的三种方式](#给-ai-接入的三种方式)
- [安全设计](#安全设计)
- [安装](#安装)
- [环境要求](#环境要求)
- [性能实测](#性能实测)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [关键词](#关键词)
- [License](#license)

---

## 这是什么

**一个给 AI 用的打印接口。**

正常情况，AI 想帮你打印一份文件，链路是这样的：

```
AI 打开文件 → 找"文件-打印" → 弹窗选打印机 → 调纸张/边距 → 点确定 → 你还得自己去看有没有打出来
```

装上这个技能之后：

```
你：把桌面那个报价单打出来
AI：（执行一条命令）OK 2p 2.4s -> 你的打印机名
```

**一次调用，四秒出纸。**

它不是打印机驱动，也不是 GUI 程序——它是一个**可以被 AI 调用的打印接口**，包含三个部分：

| 组成 | 作用 |
|---|---|
| `printer` 命令行 | AI 直接执行，或人手动用 |
| `mcp/printer-mcp.mjs` | MCP 服务，Claude/Cursor 等客户端可直接挂载成工具 |
| `SKILL.md` | 技能说明，DSH / WorkBuddy 等宿主读了就知道什么时候该调用它 |

---

## 30 秒上手

```powershell
# 1. 装（不需要管理员权限）
git clone https://github.com/<owner>/ai-printer-skill.git
cd ai-printer-skill
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath

# 2. 新开一个 cmd 窗口（PATH 要重新加载）

# 3. 看看有哪些打印机
printer printers

# 4. 打一页试试（不耗纸：输出成 PDF）
printer "README.md" --printer "Microsoft Print to PDF"
```

真机出纸：

```cmd
printer "C:\Users\me\Desktop\报价单.txt" --printer "<你的打印机名>"
```

---

## 为什么需要它

AI 直接操作打印，有四个实际痛点：

| 痛点 | 具体表现 | 本项目的做法 |
|---|---|---|
| **不可控** | AI 调起打印对话框就卡住，人得手动点 | 一条命令提交完就返回，不用任何交互 |
| **不可验证** | 打没打、打了几页、有没有报错，AI 完全不知道 | 输出一行结果 + 标准退出码，可编程判断 |
| **不安全** | 一不小心打到真机、打 200 页、重复打 5 次 | 白名单 + 页数/份数上限 + 60 秒去重 |
| **慢** | 打开 Office、等渲染、等响应 | 冷启动 2.4 秒起，不装依赖、不开 GUI |

---

## 功能一览

| 输入 | 命令 | 依赖 | 说明 |
|---|---|---|---|
| 文本 `.txt` | `printer a.txt --printer "..."` | 无 | 微软雅黑 10.5pt、行距 1.5、自动分页 |
| Markdown `.md` | `printer a.md --printer "..."` | 无 | 标题分级（16/14/12.5pt）、列表加点 |
| 一段文字 | `printer text "..."` | 无 | 不用先存文件 |
| 网页 | `printer url https://...` | Python + pymupdf | Edge 无头渲染 → 逐页转图 |
| 图片 | `printer a.jpg` | 无 | 等比缩放居中，不放大 |
| PDF | `printer a.pdf` | Python + pymupdf | 逐页 200dpi 渲染，页序不变 |
| Word | `printer a.docx` | Office（可选） | 有 Office 保版面；没有自动降级纯文本 |
| Excel | `printer a.xlsx` | Office（可选） | 只打第一张表，可横向、可调缩放 |

其他能力：

- **一页适配**：`--fit-pages 1` 自动缩字号/行距，把内容压进指定页数
- **批量**：一次命令打多个输入，某个失败不影响其他
- **静默输出**：`-q` 只回一行，适合程序调用
- **JSON 输出**：`--json` 给自动化用，字段固定
- **重复保护**：同内容 60 秒内第二次直接拒
- **PDF 落盘**：打到 `Microsoft Print to PDF` 时生成 PDF 文件，方便预览

---

## 配置：先把自己的打印机加进白名单

出于安全考虑，**默认只允许 `Microsoft Print to PDF`**，装完不能直接打真机。
要用自己的打印机，编辑安装目录下的 `config.json`（安装时会从 `config.example.json` 复制一份）：

```json
{
  "printers": {
    "allow": ["Microsoft Print to PDF", "你的打印机名"],
    "default": "Microsoft Print to PDF",
    "allowRealPrinter": true,
    "realPrinters": ["你的打印机名"]
  }
}
```

三个关键字段：

| 字段 | 作用 |
|---|---|
| `allow` | 允许使用的打印机清单，**名字必须与 `printer printers` 输出完全一致** |
| `default` | 不写 `--printer` 时用哪台；建议保持 PDF，避免误打 |
| `realPrinters` | 哪些是"会耗纸"的真机（用于提示与测试模式判断） |

查名字：

```cmd
printer printers
::  NAME                                    DEFAULT  STATUS  WHITELIST
::  Microsoft Print to PDF                           Normal  yes
::  Your Printer Name                                Idle    no   <- 你的机器
```

改完不需要重启，下一条命令就生效。

## 使用说明

### 1. 打文件

```cmd
printer "D:\文档\周报.md" --printer "<你的打印机名>"
```

输出：

```text
OK
file: D:\文档\周报.md
printer: 你的打印机名
pages: 3, copies: 1, paper: A4
submitted to printer (no file output)
elapsed: 2410 ms
```

### 2. 打一段文字（不存文件）

```cmd
printer text "明天上午九点开会，请准时参加。" --printer "Microsoft Print to PDF"
```

甚至可以直接把文字当第一个参数（不是文件也不是网址时自动按文字处理）：

```cmd
printer "明天上午九点开会" --printer "Microsoft Print to PDF"
```

### 3. 打网页

```cmd
printer url https://example.com --printer "Microsoft Print to PDF"
```

内部流程：Edge 无头渲染成 PDF → 每页转 200dpi PNG → 按图片打印。
好处是**不依赖系统里有没有 PDF 阅读器**，坏处是网页里的超链接不可点。

### 4. 打图片

```cmd
printer "C:\Users\me\Pictures\截图.png" --printer "..."
```

等比缩放、居中，**不会放大超过原图**，所以小图不会糊成大图。

### 5. 打 PDF / Word / Excel

```cmd
printer 发票.pdf   --printer "..."                 # 逐页渲染，页序不变
printer 报价单.docx --printer "..."                 # 保版面（约 9 秒）
printer 报价单.docx --printer "..." --fast          # 纯文本重排（约 3 秒）
printer 数据表.xlsx --printer "..." --landscape     # 横向，表格不裁列
printer 数据表.xlsx --printer "..." --xlsx-scale 130  # 放大 30%，可能分 2 页
```

**保版面 vs `--fast` 怎么选：**

| | 保版面（默认） | `--fast` |
|---|---|---|
| 依赖 | 需要装 Office | 不需要 |
| 速度 | 约 9 秒 | 约 3 秒 |
| 版面 | 与屏幕上一致 | 重排（字体统一、行距 1.5） |
| 图片/复杂表格 | 保留 | 丢失 |
| 适用 | 合同、发票、要交出去的文档 | 自己看的草稿、纯文字 |

### 6. 一页适配（很常用）

用户说"打在一张纸上"时，不要手调字号，直接：

```cmd
printer 长文档.md --printer "..." --fit-pages 1
```

它会从 10.5pt 开始逐档缩字号（最低 5.5pt），每个字号再试行距 1.5 / 1.25 / 1.05，
一次命令内算完，输出会告诉你最终用了多大字：

```text
OK 1p 5.3s [字号 7pt] -> 你的打印机名
```

如果 5.5pt 还放不下，**照样打出来**，但会返回退出码 **2** 并输出：

```text
WARN[2] 已打印 5p [字号 5.5pt]，但没压进 1 页 -> Microsoft Print to PDF
```

这样脚本/agent 能判断「目标没达成」，不会把失败当成功。

### 7. 批量打印

```cmd
printer a.txt b.docx text:补充说明 "C:\图片.png" --printer "..."
```

- 按顺序打
- 某个失败继续打后面的
- 最后汇总：`OK 3/4 (1 failed)`，退出码非 0

### 8. 静默与 JSON（给程序用）

```cmd
printer a.txt --printer "..." -q
:: OK 1p 2.1s -> Microsoft Print to PDF

printer a.txt --printer "..." --json
:: {"ok":true,"data":{"pages":1,"outputPdf":"...","ps":{...}},"resultLine":"OK 1p 2.1s -> ..."}
```

失败时也是一行，便于判断：

```text
ERR[3] printer not found: HP 1020
```

### 9. 重复打印保护

同一份内容 60 秒内打第二次会被拒绝：

```text
ERR[7] 60 秒内已打印过相同内容，如需重打加 --force
```

确实要重打就加 `--force`；想彻底关掉去重用 `--dedupe 0`。

### 10. 完整参数表

| 参数 | 作用 | 默认 |
|---|---|---|
| `--printer <名字>` | 指定打印机（**必填或依赖配置**） | 配置文件里的默认 |
| `--copies <n>` | 份数 | 1（>5 需 `--force`，上限 50） |
| `--paper A4\|A5\|Letter` | 纸张 | A4 |
| `--landscape` | 横向 | 纵向 |
| `--fit-pages <n>` | 自动缩字号压进 n 页 | 关 |
| `--font-size <pt>` | 文字字号 | 10.5 |
| `--margin <mm>` | 页边距 | 20 |
| `--xlsx-scale <n>` | Excel 导出缩放（80/100/130/actual） | 自动 |
| `--fast` | Word/Excel 跳过 Office，走纯解析 | 关 |
| `--dedupe <秒>` | 重复打印窗口，0 关闭 | 60 |
| `--force` | 跳过份数/页数/去重限制 | 关 |
| `--dry-run` | 只校验，不打印不落盘 | 关 |
| `--q\|--quiet` | 只输出一行 | 关 |
| `--json` | 输出 JSON | 关 |
| `--out <目录>` | PDF 落盘目录 | `<安装目录>\test-out` |

---

## 给 AI 接入的三种方式

### 方式 A：命令行（最通用）

任何能执行 shell 的 agent 都能用。给它的说明只需要三句：

```text
1. 打印前先跑 printer printers 确认打印机名字
2. 用 printer "<文件>" --printer "<名字>" 打印，一次一条
3. 看退出码：0 成功，其他见 README 的退出码表
```

### 方式 B：MCP 服务器

`mcp/printer-mcp.mjs` 是一个零依赖的 stdio MCP 服务，暴露 5 个工具：

| 工具 | 作用 |
|---|---|
| `list_printers` | 列出打印机和白名单 |
| `print_file` | 打印文件（支持 `fit_pages`、`force`） |
| `print_text` | 直接打印文本（支持 `fit_pages`） |
| `print_url` | 打印网页 |
| `printer_status` | 查看版本/配置/日志目录 |

Claude Desktop / Cursor 之类的配置示例：

```json
{
  "mcpServers": {
    "printer": {
      "command": "node",
      "args": ["C:\\Users\\me\\.ai-skills\\printer\\mcp\\printer-mcp.mjs"]
    }
  }
}
```

也可以让脚本自动写配置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\mcp\register-mcp.ps1 -Agent all
```

### 方式 C：技能文件

`SKILL.md` 是给"支持技能目录"的宿主用的（DSH、WorkBuddy、Claude Skills 等）。
把它放进宿主的 skills 目录，宿主就知道**什么时候该调用 printer、怎么选打印机、什么不能打**。

装的时候加参数可以顺便注册：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath -DshHome "C:\Users\me\.dsh\home"
```

---

## 安全设计

打印是**会耗纸、会出声、不可撤销**的动作——所以默认设置偏保守：

| 保护 | 行为 |
|---|---|
| 打印机白名单 | 只打 `config.json` 里 `printers.allow` 列出的机器；**系统默认打印机永远不会被隐式使用** |
| 拒绝可执行文件 | `.exe .bat .cmd .ps1 .msi .vbs .scr` 一律拒绝（退出码 6） |
| 页数上限 | 文档超过 50 页默认拒绝，`--force` 可越过 |
| 份数上限 | 超过 5 份需 `--force`，硬上限 50 |
| 重复保护 | 同内容 60 秒内不重打 |
| 传真机 | 名字含 `Fax` 直接拒绝 |
| 真机开关 | `allowRealPrinter: false` 时只能打 PDF 打印机 |

**退出码表**（程序判断用）：

| 码 | 含义 | 典型场景 |
|---|---|---|
| 0 | 成功 | — |
| 2 | 参数错误 / 目标未达成 | 文件不存在、份数越界、页数超限、`--fit-pages` 没压进要求页数 |
| 3 | 打印机问题 | 名字写错、不在白名单 |
| 4 | 渲染失败 | 缺 Python/pymupdf、Office 转 PDF 失败 |
| 5 | 提交打印失败 | 打印机脱机、队列报错 |
| 6 | 安全拒绝 | 可执行文件、传真机 |
| 7 | 重复打印 | 60 秒内同内容 |

---

## 安装

### 方式零：直接下载安装包（不装 git）

到 [Releases](https://github.com/xc2228-create/ai-printer-skill/releases) 下载 `ai-printer-skill-*.zip`，
解压后双击 `install.cmd`，或把解压目录里的 `安装提示词.md` 丢给 AI。

> 每个 Release 资产都带下载计数，方便看有多少人在用。

### 方式一：让 AI 帮你装（推荐，最简单）

仓库里有 [docs/install-prompt.md](docs/install-prompt.md)，把路径丢给任意能执行命令的 AI：

> 读 `C:\path\to\install-prompt.md`，按里面步骤安装，装完按它的回报格式告诉我。

它会自己检查 Node 版本、解压、安装、跑三条验证，然后回报结果。

### 方式二：手动装

```powershell
git clone https://github.com/<owner>/ai-printer-skill.git
cd ai-printer-skill
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath
```

装完**新开一个 cmd 窗口**，跑：

```cmd
where printer
printer status
printer "README.md" --printer "Microsoft Print to PDF" --dry-run
```

三条都正常才算装好。

### 方式三：只要命令行，不要 PATH

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NoPath
:: 之后用全路径调用
& "$env:USERPROFILE\.ai-skills\printer\shim\printer.cmd" printers
```

### 同步安装到 AI 宿主（DSH / WorkBuddy）

装 CLI 只是第一步；要让宿主「知道有这个技能」，还要把**技能说明**和（可选的）**插件/MCP** 注册进去。
安装器把这两件事一起做了：

| 宿主 | 命令 | 装什么 |
|---|---|---|
| **DSH** | `install.ps1 -WithDsh -DshHome "<dsh home>"` | 插件 `@local/printer`（4 个工具）+ 技能 `<dsh home>\skills\printer\SKILL.md` + `cordis.patch.yml` 注册段 |
| **WorkBuddy** | `install.ps1 -WithWorkBuddy` | 技能 `%USERPROFILE%\.workbuddy\skills\printer\SKILL.md` + `mcp.json` 的 `printer`（stdio） |
| 两个都要 | `install.ps1 -WithDsh -DshHome "<home>" -WithWorkBuddy` | 上面全部 |

```powershell
# 例：本机 DSH + WorkBuddy 都接上
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath `
  -WithDsh -DshHome "C:\Users\me\.dsh\home" -WithWorkBuddy
```

要点：

- **幂等**：重复执行只更新有变化的文件；`cordis.patch.yml` 与 `mcp.json` 改前会备份成 `.bak-<时间戳>`
- **技能目录热加载**：DSH / WorkBuddy 的技能列表一般不需要重启；**插件与 MCP 需要重启宿主**
- `-WorkBuddyHome` 可指定非默认的 WorkBuddy 目录
- 只想看会动哪些文件：加 `-DryRun`

### 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.ai-skills\printer\uninstall.ps1"
```

卸载只把安装目录改名（`printer.removed-<时间戳>`），**不删除任何文件**，随时可以改回来。

宿主里的注册需要手工清：DSH 删 `skills\printer` 与 `cordis.patch.yml` 的注册段；WorkBuddy 删 `skills\printer` 与 `mcp.json` 的 `printer` 条目。

卸载只把目录改名（`printer.removed-<时间戳>`），**不删除任何文件**，随时可以改回来。

---

## 环境要求

| 依赖 | 是否必需 | 用途 |
|---|---|---|
| **Windows 10/11** | 必需 | 本项目用 Windows 打印子系统 |
| **Node.js ≥ 18** | 必需 | 运行 CLI 和 MCP 服务 |
| PowerShell 5.1+ | 必需 | 系统自带，负责实际提交打印 |
| Python 3 + pymupdf | 可选 | 打印网页、PDF |
| Microsoft Office | 可选 | Word/Excel 的"保版面"路径 |

缺可选依赖时不会静默出错：会用退出码 4 明确告诉你缺什么，并自动降级（比如没有 Office 就打纯文本版）。

---

## 性能实测

同一台机器（Windows 11 + USB 激光一体机）实测：

| 场景 | 耗时 |
|---|---|
| 文本单页（冷启动） | **2.4–2.6 秒** |
| 文本单页（连续第 2 次） | 2.0 秒 |
| Markdown 3 页 | 2.4 秒 |
| 图片单页 | 1.8 秒 |
| 网页 1 页 | 5–9 秒（Edge 渲染占大头） |
| Word 保版面 | 约 9 秒（每次冷启 Word） |
| Word `--fast` | 3.3 秒 |
| Excel 保版面 | 约 10 秒 |
| PDF 60 页 | 19 秒 |

对比"人工点打印"：省掉的是**对话框、选打印机、点确定的交互时间**，以及 AI 反复试探参数的多轮对话。

---

## 常见问题

**Q：`printer` 提示"不是内部或外部命令"？**
PATH 改动对已打开的窗口不生效，**新开一个 cmd 窗口**再试。

**Q：为什么不叫 `print`？**
`print` 是 Windows 自带的 `C:\Windows\System32\print.exe`，而且 System32 在 PATH 里永远排在前面，抢不过它。它会把 `--printer` 当成文件名。

**Q：会不会不小心打到真机浪费纸？**
不会隐式使用默认打印机；真机必须显式写名字，且在 `config.json` 白名单里。所有文档都建议先打到 `Microsoft Print to PDF` 看效果。

**Q：打出来字太小怎么办？**
表格加 `--landscape`；仍小用 `--xlsx-scale 130`；文本用 `--fit-pages 1` 或 `--font-size 12`。

**Q：能打图片里的表格吗？**
不能。本项目不做 OCR，扫描件按图片打，文字不可搜索。

**Q：支持 Linux / macOS 吗？**
不支持。底层用的是 `.NET PrintDocument`（Windows 打印子系统）。移植的话需要换 CUPS 接口。

**Q：一份文档有多个工作表/多个 sheet 呢？**
Excel 只打第一张表，输出里会提示表名。要打其他表先在 Excel 里切过去另存。

**Q：`ERR[4]` 是什么？**
渲染失败。打网页/PDF 时通常是缺 Python 或 pymupdf；打 Word/Excel 时是 Office COM 不可用且纯解析也失败。

**Q：日志在哪？**
`%USERPROFILE%\.ai-skills\printer\logs\print-YYYYMMDD.jsonl`，每次调用一行 JSON。

**Q：能改成别的配置目录吗？**
能，安装时用 `-Target` 指定；配置在安装目录的 `config.json`。

---

## 项目结构

```text
printer-skill/
├─ src/
│  ├─ print-cli.mjs          命令行入口（参数解析、流程编排）
│  ├─ lib/                   各职责模块（配置、打印机、排版、渲染、去重、日志）
│  └─ ps/                    PowerShell 打印脚本（实际提交打印的地方）
├─ shim/printer.cmd          暴露到 PATH 的包装器
├─ mcp/printer-mcp.mjs       MCP stdio 服务（零依赖）
├─ mcp/register-mcp.ps1      自动注册到 AI 宿主
├─ plugin/@local/printer/    DSH 原生插件（可选）
├─ docs/install-prompt.md    给 AI 读的安装说明
├─ docs/test-checklist.md    50 条测试清单
├─ install.ps1 / install.cmd 安装器（双击版和参数版）
├─ ai-install.ps1            一键安装 + 自检 + JSON 结果
├─ uninstall.ps1             卸载（只改名不删除）
├─ SKILL.md                  技能说明（给 AI 宿主）
└─ config.example.json       配置样例（白名单/默认打印机/上限）
```

---

## 开发与测试

不需要安装就能跑：

```powershell
node src\print-cli.mjs status
node src\print-cli.mjs "README.md" --printer "Microsoft Print to PDF" --dry-run
node test\run-tests.mjs      # 需要本机有 "Microsoft Print to PDF"
```

约束：

1. **运行时零依赖**——不要再往运行路径里引 npm 包
2. **所有 .ps1 必须 UTF-8 with BOM**——否则 Windows PowerShell 5.1 会把中文读成乱码（CI 会检查）
3. **测试只打 PDF 打印机**——不要把真机写进测试
4. **改打印安全相关逻辑要带反面用例**——比如"白名单外应该拒绝"

CI 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)：node 语法、PowerShell 语法、BOM 检查、dry-run 冒烟。

---

## 用户反馈与评价

这个项目还在早期，**每一条反馈都会看**。三种方式，随便挑一个：

| 方式 | 适合 | 入口 |
|---|---|---|
| **使用体验 / 评价** | 用完了想说两句、打分 | [提交体验反馈](https://github.com/xc2228-create/ai-printer-skill/issues/new?template=feedback.yml) |
| **Bug 报告** | 打印失败、报错、结果不对 | [报告 Bug](https://github.com/xc2228-create/ai-printer-skill/issues/new?template=bug_report.yml) |
| **功能建议** | 想要新格式/新参数 | [提建议](https://github.com/xc2228-create/ai-printer-skill/issues/new?template=feature_request.yml) |

**如果不方便开 issue**，点个 ⭐ 也算反馈——它能让更多需要的人搜到这个项目。

### 评价模板（复制即用）

```text
满意度：5 / 4 / 3 / 2 / 1
版本：print-cli 1.3.1
我用它做什么：让 AI 帮我打日报 / 批量打发票 / 打练习卷
最顺手的地方：
最想改的地方：
```

### 已知的真实使用场景

- 让 AI 把一段话直接打成一页 A4，不用自己开 Word 排版
- 发票 PDF 批量出纸（带 50 页保护，不会一次吐两百张）
- 网页内容（政策通知、公告）直接出纸，不用先另存 PDF
- 表格横向打印，解决"列被裁掉"的老问题

> 如果你的用法不在上面，欢迎在反馈里写一句——它可能变成 README 里的一个用例。

## 关键词

> 以下关键词用于 GitHub Topics 与搜索引擎收录（也写给需要搜到本项目的人）。

**中文**：AI 打印 / 打印机命令行 / 自动打印 / 批量打印 / 静默打印 / 无弹窗打印 / 打印 PDF / 打印 Word / 打印 Excel / 打印网页 / 一页打印 / 打印到一页 / AI 助手工具 / 智能体工具 / 打印技能

**English**：AI printing, print from CLI, silent printing, headless printing, print PDF, print DOCX, print XLSX, print URL, MCP server, AI agent tools, LLM tool, Windows printer CLI, no-dialog printing, fit to one page, print automation

**GitHub Topics**：`ai` `printing` `windows` `mcp` `mcp-server` `cli` `agent` `llm` `automation` `printer` `pdf` `docx` `xlsx` `zero-dependency` `nodejs` `powershell` `skill` `ai-tools`

---

## English

`printer-skill` is a Windows printing CLI **and** MCP server for AI agents.
One command prints files, raw text, URLs, images, PDF, DOCX and XLSX — no dialogs, no print preview, no implicit default printer.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath
printer "README.md" --printer "Microsoft Print to PDF" --dry-run
printer text "hello world" --printer "Microsoft Print to PDF"
```

Features: fit-to-N-pages auto shrinking, batch inputs, 60s duplicate guard, printer allow-list, executable refusal, standard exit codes, zero runtime dependencies.
Requires Windows 10/11 + Node ≥ 18; Python (pymupdf) and Microsoft Office are optional.

---

## License

MIT — see [LICENSE](LICENSE).
