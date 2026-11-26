---
name: printer
description: Windows 打印技能。用户说「打印」「打出来」「出纸」「打一份」时，用 printer 命令打印文件、一段文字或网页；
  必须先查打印机再选，禁止猜系统默认，禁止打印可执行文件，份数上限 5。命令是 printer，不是 Windows 自带的 print。
version: 1.4.0
platform: windows
entrypoint: printer
exit_codes: 0=成功 2=参数/目标未达成 3=打印机 4=渲染 5=打印 6=安全拒绝 7=重复打印
metadata:
  requires:
    bins:
      - printer
    cliHelp: printer help
  runtime: Node.js >= 18（打印网页另需 Python 3 + pymupdf）
---

# AI 打印机技能（printer-skill）

把「打印」这件事做成一条命令。装好后，用户说一句「把这个打出来」，你就能查打印机、选打印机、出纸或落 PDF。

> ⚠️ **命令名是 `printer`，不是 `print`。**
> `print` 是 Windows 自带命令（`C:\Windows\System32\print.exe`），而系统目录在合并后的 PATH 里
> **永远排在用户 PATH 前面** —— 敲 `print` 命中的是系统命令，它会把 `--printer`、`--dry-run` 当文件名，
> 有可能**真的打到默认打印机**。所以本技能的命令名是 `printer`；文档里若出现 `print <文件>`，那是错的。

- 命令名：`printer`（安装器加的 shim，等价于 `node <安装目录>\src\print-cli.mjs`）
- 支持格式：`.txt` `.md` `.png` `.jpg` `.jpeg` `.pdf` `.docx` `.xlsx`
- 输出：真机出纸，或 `Microsoft Print to PDF` 落一份 PDF 到 `<安装目录>\test-out\`

---

## 1. 什么时候用

触发词（用户说了其中之一，且手上有文件）：

| 用户说 | 你该做 |
| --- | --- |
| 「打印」「打出来」「出纸」「打一份」「印一下」「纸质版」 | 走下面三步 |
| 「打成 PDF」「存成 PDF 再打」 | 选 `Microsoft Print to PDF` |
| 「打几份」「打印 3 份」 | 加 `--copies 3`（上限 5） |
| 「横着打」「横向」 | 加 `--landscape` |
| 「把这段话打出来」+ 一段文字 | `printer "那段文字"` 或 `printer text "..."`（不用先存文件） |
| 「把这个网页/链接打出来」 | `printer url <http(s)://...>`（Edge + pymupdf 链路） |

**不要用**（明确拒绝并说明原因）：

- PPTX 直印 —— 不支持（PDF / DOCX / XLSX 从 1.2.0 起支持），先转成 PDF 或截图 `.png`
- 超过 50 页的文档 —— 默认拒绝（退出码 2），确实要打才加 `--force`
- 传真（`Fax` 打印机）—— 安全规则直接拒绝，退出码 6
- 后台队列 / 定时 / 无人值守打印 —— 只做「用户当下要求的一次调用」（一次调用可带多个输入，串行打完即返回）
- 打印 `.exe` `.bat` `.cmd` `.ps1` `.msi` `.vbs` `.scr` —— 一律退出码 6，不要尝试绕过

---

## 2. 三步用法

### 第 1 步：查打印机

~~~powershell
printer printers
~~~

输出示例：

~~~text
NAME                                    DEFAULT  STATUS  WHITELIST
Microsoft Print to PDF                           Normal  yes
你的打印机名  *        Normal  yes
Fax                                              Normal  no
~~~

看三列：`WHITELIST=yes` 才能用；`DEFAULT=*` 只是「Windows 当前的默认打印机」，**不是**你要用的打印机；`STATUS` 不是 `Normal` 时要提醒用户。

### 第 2 步：选打印机（这一步不许猜）

| 场景 | 选哪台 |
| --- | --- |
| 用户没说要纸，只是想看排版 / 测试 | `Microsoft Print to PDF` |
| 用户明确要「打出来」「出纸」 | 用户指定的真机名；用户没指定就问一句，别自己选 |
| 只有一台 `WHITELIST=yes` 的真机 | 仍需在回复里说明你要用它，再打 |
| 真机 `STATUS` 是 `Offline` / `Stopped` | 停下，告诉用户，不要重试 |

**绝对不要**因为某台打印机带 `*`（系统默认）就选它 —— 本机默认恰好是真机，盲选会直接耗纸。

### 第 3 步：打印（**秒打原则：默认不要演练**）

用户说「打印 / 打出来 / 出纸」时，**直接执行一条命令**，不要再跑 `--dry-run`。
每次多跑一次 dry-run，就多一轮对话，用户要多等几十秒——这是本项目最主要的慢因。

~~~powershell
# 直接打（用户已明确要求）
printer "C:\Users\me\Desktop\报价单.txt" --printer "Microsoft Print to PDF"

# 直接从一段文字打（不用先存文件）
printer text "要打印的内容" --printer "Microsoft Print to PDF"

# 直接打一个网页
printer url https://example.com --printer "Microsoft Print to PDF"
~~~

**用户说「打在一张纸上 / 打一页 / 控制在一页」时，直接用 `--fit-pages 1`**：
一条命令自动把字号从 10.5 缩到能放下为止（必要时再压行距 1.5→1.25→1.05），
输出里会带 `[字号 7pt]`。**不要**再反复换字号、反复 dry-run 试探——那是几分钟和几秒钟的差别。

**下限是 5.5pt**：内容实在太多时（例如 12 页 README 压 1 页），缩到 5.5pt 仍放不下，
工具会**照常打印**，但输出 `WARN[2] ... 没压进 1 页` 且**退出码为 2**（目标未达成，别当成成功）。
看到 `WARN[2]` 时**不要**反复重试同一个参数，直接告诉用户「1 页装不下，最小 5.5pt 时是 N 页」，
让他选：接受多页 / 精简内容 / 换 A3 或缩小页边距。

**只有这三种情况才先用 `--dry-run`：**
1. 装完技能后的**第一次**打印（验证链路）
2. 文件来自网络下载、或用户说「先看看排版」
3. 用户明确说「先演练 / 别真打」

打完**一行回报即可**（`OK 2p 2.3s -> 打印机名`），不要复述整段输出、不要解释退出码。

成功输出形如：

~~~text
OK
file: C:\Users\me\Desktop\报价单.txt
printer: Microsoft Print to PDF
pages: 2, copies: 1, paper: A4
pdf: C:\Users\me\.ai-skills\printer\test-out\报价单-20261123-213045-120.pdf
elapsed: 1830 ms
~~~

看到 `OK` 才算成功；看到 `ERROR[码]` 就按第 5 节处理。

---

## 3. 命令与参数

| 命令 | 作用 |
| --- | --- |
| `printer printers` | 列打印机（名字 / 是否默认 / 状态 / 是否白名单） |
| `printer status` | 运行环境：node 版本、config 路径、白名单、输出目录 |
| `printer <输入>` | 打印（`print` 子命令可省略） |
| `printer print <输入...>` | 打印；多个输入 = 批量，顺序执行、遇错不中断 |
| `printer text "<文字>"` | 直接排版打印一段文字，不用先存文件 |
| `printer url <http(s)://...>` | Edge 无头渲染 PDF → 每页 200dpi PNG → 走图片打印 |
| `printer --help` | 帮助 |

> 三种写法都成立：`printer printers` / `printer <文件> --printer "..."` / `printer print <文件> --printer "..."`。
> **但永远不要用 `print`**（Windows 自带命令，会命中 System32）。

| 选项 | 说明 | 默认 |
| --- | --- | --- |
| `--printer <名字>` | **必填**，名字从 `printer printers` 原样复制 | 无（不猜） |
| `--copies <n>` | 份数，1–5；>5 直接拒绝（要更多请用户手动改 config） | 1 |
| `--paper A4\|A5\|Letter` | 纸张 | A4 |
| `--landscape` | 横向 | 关 |
| `--dry-run` | 只校验，不提交、不落 PDF | 关 |
| `--json` | 机器可读信封（自动化/插件用），新增 `resultLine` 单行文本 | 关 |
| `--quiet` / `-q` | 只输出一行 `OK 1p 3.2s -> <打印机>`；失败一行 `ERR[码] 原因` | 关 |
| `--out <目录>` | PDF 落盘目录 | `<安装目录>\test-out` |
| `--dedupe <秒>` | 相同内容重复打印保护窗口；0 = 关闭 | 60 |
| `--force` | 超过 5 份、超过 50 页、或跳过 60 秒去重 | 关 |
| `--fit-pages <n>` | **自动缩字号/行距，把内容压进 n 页**（"打在一张纸上"就用它，不要手试字号） | 关 |
| `--font-size <pt>` | 文本字号（启用 `--fit-pages` 时作为**上限**，自动往下缩） | 10.5 |
| `--margin <mm>` | 页边距 | 20 |
| `--file` | 强制把位置参数按文件解释（无同名文件时默认按文字） | 关 |

路径含空格或中文：整段用双引号包住即可（shim 会原样透传）。

### 3.1 「秒打」四个约定（1.1.0）

- **不用先写文件**：第一个参数既不是已存在的文件、也不是 URL 时，按文字直接打印；显式写 `printer text "..."`。确实有同名文件时用 `--file` 强制按文件解释。
- **短输出**：加 `--quiet`（`-q`）只回一行 `OK 1p 3.2s -> Microsoft Print to PDF`；失败一行 `ERR[码] 原因`；`--json` 里用 `resultLine` 字段直接转述。
- **一次多个输入**：`printer a.txt text:你好 url:https://example.com` 顺序打，某项失败不中断，末尾汇总 `OK 2/3 (1 failed)`，退出码取第一个失败的码。
- **防重复**：同一内容 + 同一打印机/份数/纸张/方向，60 秒内第二次调用直接退出码 **7**（提示加 `--force`）；`--dedupe <秒>` 调窗口，`--dedupe 0` 关闭；dry-run 不参与去重。

版式默认值：微软雅黑 10.5pt、行距 1.5、页边距 20mm；Markdown 的 1/2/3 级标题 16/14/12.5pt，列表前缀「· 」；图片等比缩放居中、不放大超过原尺寸 100%；页脚 `文件名 · 第 x/y 页`。

### 3.2 文档格式 PDF / DOCX / XLSX（1.2.x）

| 格式 | 链路 | 说明 |
| --- | --- | --- |
| `.pdf` | 每页 pymupdf 渲染 200dpi PNG → 图片打印 | 页数与顺序不变；PDF 本身是横向时自动横向；**>50 页默认拒绝**，加 `--force` 才打 |
| `.docx` | A：Word COM → PDF → 同上；A 失败自动降级 B：读 `word/document.xml` → 结构化文本（标题 16/14/12.5pt） | A 保格式、B 保内容；两条都失败退出码 4 |
| `.xlsx` | A：Excel COM 只导出**第一张表** → PDF → 同上；降级 B：`sharedStrings` + 第一张表 → 等宽表格文本（宋体，` | ` 分列，长文本截断加 `…`，每 40 行分页并重复表头） | 多表时只打第一张并在输出里提示「仅打印第一张：<名>」 |

- 文档路径默认页边距 0（PDF/Office 已自带版式），只有降级到文本链路时才用 `--margin`（默认 20mm）。
- `printer a.pdf b.docx text:你好 --printer "..."` 可以混在批量里，去重同样生效（同一文件 60 秒内第二次 → 退出码 7）。
- 依赖：PDF/DOCX/XLSX 都需要本机 Python 3；`.pdf` 需 pymupdf，DOCX 的 B 路径优先 python-docx（缺失时退回 zip 解析），XLSX 的 B 路径优先 openpyxl。缺依赖会明确报「需要 Python 3 + …」，不会静默打错东西。
- **速度差异**（实测）：`.docx` 走 A（Word COM）约 **9 秒**（每次冷启 Word），加 `--fast` 走 B 约 **3.3 秒**；`.xlsx` 同理（A ≈10 秒 / `--fast` ≈4.4 秒）。
  → **用户催速度、或文档以文字/表格为主时用 `--fast`**；要求版面一模一样时不要加。
- 设置 `PRINTER_NO_COM=1` 与 `--fast` 等价（没有装 Office 的机器、或要验证 B 路径时用）。

---

## 4. 硬规则（违反任何一条都算执行失败）

1. **必须显式 `--printer`**。命令行缺省时 CLI 会退回 config 里的默认值，但那是兜底，不是许可 —— 你的调用里不许省。
2. **不猜系统默认打印机**。`printer printers` 里带 `*` 的那台只做展示；本机默认往往就是真机。
3. **真机打印前必须让用户明确同意**。用户说「打出来」= 同意；你自作主张 = 违规。不确定就先 `--dry-run` 并把参数念给用户听。
4. **份数上限 5**。用户要 10 份，先问是不是真的要这么多，再让用户自己决定是否改 `config.json`。
5. **可执行文件一律拒绝**（`.exe .bat .cmd .ps1 .msi .vbs .scr`），不要改扩展名绕过。
6. **不装驱动、不点系统弹窗、不改系统默认打印机**。需要这些的事一律交还用户。
7. **失败不要连续重试同一条命令**。读错误码，改参数，或停下来问。

---

## 5. 错误码对照表

| 码 | 含义 | 常见原因 | 处置 |
| --- | --- | --- | --- |
| 0 | 成功 | —— | 把 PDF 路径或「已提交打印」告诉用户 |
| 2 | 参数错误 | 缺文件路径、`--copies` 非数字或 >5、`--paper` 拼错、文件不存在/为空、扩展名不支持、**文档超过 50 页** | 按报错文字改参数后重跑一次；文件问题让用户确认真实路径；超页数先问用户是否真要打 |
| 3 | 打印机不存在 / 不在白名单 | 名字拼错、打印机被删、用了 `Fax` 或 `AnyDesk` | 重跑 `printer printers`，从输出里原样复制 `WHITELIST=yes` 的名字 |
| 4 | 渲染失败 | 文本编码坏、图片/PDF 损坏、Word/Excel COM 与 XML 解析都失败、PowerShell 脚本被改动、磁盘满 | 换个文件试（先 `--dry-run`）；仍失败就把报错原文交给用户，不要反复试 |
| 5 | 打印失败 | 队列卡住、驱动异常、Spooler 停止、PDF 生成失败 | 先用 `printer status` + 查队列；真机异常时停下报告，不要连续重试 |
| 6 | 被安全规则拒绝 | 可执行文件、Fax、XPS、`P1_TEST_MODE` 下打真机 | 直接告诉用户「这条被安全规则禁止」，不要换文件名或换打印机绕过 |
| 7 | 重复打印被拦 | 60 秒内同一内容 + 同一打印机/份数/纸张/方向已打过 | 告诉用户「刚打过，确认要再打就加 `--force`」；不要自动重试 |

排查顺序：`printer status` → `printer printers` → 同参数加 `--dry-run` → 仍失败则把原始报错贴给用户。

---

## 6. JSON 模式（给插件和自动化）

~~~powershell
printer "C:\x\a.txt" --printer "Microsoft Print to PDF" --json
~~~

~~~json
{"ok":true,"command":"print","data":{"file":"C:\\x\\a.txt","printer":"Microsoft Print to PDF","pages":1,"outputPdf":"...","dryRun":false},"error":null,"durationMs":1810}
~~~

失败时 `ok=false`、`data=null`，`error: {code, message}`，进程退出码同样是 2/3/4/5/6/7。判断成功请**同时**看退出码和 `ok`。

`resultLine` 与 `--quiet` 的那一行完全相同（成功 `OK 1p 3.2s -> <打印机>`，失败 `ERR[码] 原因`），可以直接转述给用户。

---

## 7. 两个典型回合

**A. 用户说「把桌面上的合同.txt 打出来」**

1. `printer printers` → 看到 `你的打印机名` 是 `yes`
2. 回复：「要用 USB 激光一体机 出纸，1 份 A4，对吗？」—— 用户确认
3. `printer "C:\Users\me\Desktop\合同.txt" --printer "<你的打印机名>"`
4. 输出 `OK` → 告诉用户「已提交，2 页」

**B. 用户说「帮我看看排版对不对」**

1. 直接 `printer "C:\x\a.md" --printer "Microsoft Print to PDF"`（不出纸，落 PDF）
2. 把 PDF 路径给用户；需要看图就再把 PDF 首页转 PNG

---

## 8. 自动安装提示词（整段复制给任意 AI）

> 你在 Windows 上。请帮我安装「AI 打印机技能」，步骤必须照做，不许自己发明命令：
>
> 1. 确认 `node -v` 存在且主版本 ≥ 18；没有就先告诉我，不要自己装 Node。
> 2. 找到技能包目录（含 `install.ps1`、`src\print-cli.mjs` 的那一层），记作 `<PKG>`。
> 3. 先演练：`powershell -NoProfile -ExecutionPolicy Bypass -File "<PKG>\install.ps1" -DryRun`，把它打印的「计划」贴给我看，等我确认。
> 4. 正式装（不加 `-AddToPath` 也能用，只是要用全路径调用）：
>    `powershell -NoProfile -ExecutionPolicy Bypass -File "<PKG>\install.ps1" -AddToPath`
> 5. 验证：新开一个命令行窗口，运行 `printer printers`，应列出所有打印机且退出码 0；再运行
>    `printer "<PKG>\README.md" --printer "Microsoft Print to PDF" --dry-run`，应输出 `DRY-RUN OK`。
> 6. 把 `<安装目录>\install-report.txt` 的内容摘要给我（node 版本、打印机列表、PATH 是否已加）。
> 7. 红线：不要用 `print`（那是 Windows 自带命令，会打到默认打印机，命令名是 `printer`）；不要打印真机（会耗纸）；不要改系统默认打印机；不要装驱动、不要点系统弹窗；不要修改系统级环境变量。任何一步失败就停下来把原文报错贴给我。

装好后把这份 `SKILL.md` 放进你的技能目录，或直接告诉我「按 SKILL.md 里的三步走」。

---

## 9. 不做什么

- 不做后台队列、定时、无人值守打印（一次调用可带多个输入，串行打完即返回）
- 不打印可执行文件、不碰 Fax
- 不改系统默认打印机（只读快照）
- 不代用户点「安装驱动」「同意协议」这类系统级确认
- 不删除任何文件：同名 PDF 追加序号，覆盖安装前先 `.bak-时间戳` 备份
- **不占用 `print` 命令名**：`print` 是 Windows 自带命令，本技能的命令叫 `printer`（旧版的 `print.cmd` 已删掉）
