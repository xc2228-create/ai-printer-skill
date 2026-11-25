# 打印机插件 测试清单（v1.2.3）

> 用途：装完之后照着逐条打勾。每条都写了**怎么做**、**应该看到什么**、**不对怎么办**。
> 打印类用例默认用 `Microsoft Print to PDF`（不耗纸）；真机用例集中在第 6 组，都在最后做。

## 0. 准备（2 分钟）

| # | 操作 | 通过标准 |
|---|---|---|
| 0.1 | 新开一个 **cmd 窗口**（不要用旧的） | 能打开 |
| 0.2 | `where printer` | 输出一行 `...\.ai-skills\printer\shim\printer.cmd` |
| 0.3 | `where print` | 输出 `C:\Windows\System32\print.exe`（**必须是系统这个**，说明没被抢名） |
| 0.4 | `printer status` | 第一行 `print-cli 1.2.3`；后面有 whitelist、log dir、supported 列表 |
| 0.5 | `printer printers` | 列出本机打印机；`Microsoft Print to PDF` 和 HP 那台的 WHITELIST 是 **yes** |

❌ 如果 0.2 找不到 printer：PATH 没生效 → 重开窗口；还不行看第 9 组。

## 1. 四种输入（核心）

| # | 操作 | 通过标准 |
|---|---|---|
| 1.1 | `printer "<任意txt文件>" --printer "Microsoft Print to PDF"` | `OK` + 页数 + `pdf: ...test-out\...pdf` |
| 1.2 | `printer text "这是一段直接打印的文字，不用先存文件" --printer "Microsoft Print to PDF"` | `OK 1p ...` |
| 1.3 | `printer "一段没有对应文件的文字" --printer "Microsoft Print to PDF"` | 也能打（自动识别为文字） |
| 1.4 | `printer url https://example.com --printer "Microsoft Print to PDF"` | 约 5–10 秒，出 1 页（网页截图式） |
| 1.5 | `printer "<任意图片.jpg>" --printer "Microsoft Print to PDF"` | 出 1 页，图片等比缩放居中 |

## 2. 文档格式（PDF / DOCX / XLSX）

| # | 操作 | 通过标准 |
|---|---|---|
| 2.1 | 找一个 PDF：`printer "x.pdf" --printer "Microsoft Print to PDF"` | 页数与源文件**一致** |
| 2.2 | 造 60 页 PDF 再打 | `ERR[2] 该 PDF 共 60 页，超过 50 页安全上限`，**不产生文件** |
| 2.3 | 上条加 `--force` | 能打，页数 60 |
| 2.4 | `printer "x.docx" --printer "..."`（不加 --fast） | 版面与 Word 一致，约 9 秒 |
| 2.5 | 同上加 `--fast` | 约 3 秒，文字在、版式重排 |
| 2.6 | `printer "x.xlsx" --printer "..." --landscape` | 1 页，内容占纸宽约 2/3（字清楚） |
| 2.7 | 同上加 `--xlsx-scale 130` | 变 2 页，字更大 |
| 2.8 | 多工作表的 xlsx | 只打第一张，输出里提示表名 |

## 3. 参数

| # | 操作 | 通过标准 |
|---|---|---|
| 3.1 | `-q` | **只输出一行**：`OK 1p 2.1s -> 打印机名` |
| 3.2 | `--copies 2` | 输出 `2 copies`；PDF 里是 2 份 |
| 3.3 | `--copies 9` | `ERR[2] refusing 9 copies without --force` |
| 3.4 | `--paper A5` / `--landscape` | 输出里纸张/方向跟着变 |
| 3.5 | `--font-size 14`（文字） | 出纸明显变大 |
| 3.6 | `--dry-run` | `DRY-RUN OK`，**不产生 PDF、不进队列** |
| 3.7 | `--json` | 输出一段 JSON，包含 `resultLine` 与 `data.pages` |
| 3.8 | `--printer` 写错名字 | `ERR[3] printer not found`（退出码 3） |
| 3.9 | `--bogus` | `ERR[2]` 未知参数（退出码 2） |

## 4. 去重与批量

| # | 操作 | 通过标准 |
|---|---|---|
| 4.1 | 同一个文件连打两次（第二次不带 --force） | 第二次 `ERR[7] 60 秒内已打印过相同内容` |
| 4.2 | 上条加 `--force` | 能打 |
| 4.3 | `--dedupe 0` | 不去重，连打两次都成 |
| 4.4 | 一次打 3 个：`printer a.txt text:你好 b.txt --printer "..."` | 输出 `[1/3]` `[2/3]` `[3/3]` + `OK 3/3` |
| 4.5 | 批量里混一个不存在的文件 | `OK 2/3 (1 failed)`，退出码 2，**其余照打** |

## 5. 安全（重要）

| # | 操作 | 通过标准 |
|---|---|---|
| 5.1 | `printer "C:\Windows\notepad.exe"` | `ERR[6] blocked file type`，退出码 6 |
| 5.2 | `printer "x.txt" --printer "Fax"` | `ERR[6] Fax printers are blocked` |
| 5.3 | `printer "x.txt" --printer "AnyDesk Printer"` | `ERR[3] printer rejected（不在白名单）` |
| 5.4 | 不写 `--printer` 直接打 | 用 config 里的默认（PDF），**不会偷偷打真机** |
| 5.5 | 打完之后查真机 | HP 队列应为 0（除非你真打了） |

## 6. 真机出纸（最后做，会耗纸）

| # | 操作 | 通过标准 |
|---|---|---|
| 6.1 | `printer text "打印机测试 1 页" --printer "<你的打印机名>"` | 出 1 张，字迹清楚 |
| 6.2 | 打一张图片 | 位置居中、不变形 |
| 6.3 | 打一张表格（xlsx，横版） | 字能看清、不裁列 |
| 6.4 | 打一份 docx | 与屏幕一致 |

## 7. AI 集成（MCP / 技能）

| # | 操作 | 通过标准 |
|---|---|---|
| 7.1 | 在 DSH 里问「你能打印吗」 | 能看到 printer 技能/工具（printer_list / printer_print / printer_text / printer_status） |
| 7.2 | 让 AI 打一段文字 | 一次调用完成，回复一行结果 |
| 7.3 | 在 WorkBuddy 里问「你能打印吗」 | 能看到打印技能（需重启过 WorkBuddy） |
| 7.4 | WorkBuddy 里发「打印这段：xxx」 | 能直接调用打印 |

## 8. 性能基线（可选，记个数）

| # | 操作 | 参考值 |
|---|---|---|
| 8.1 | `printer text "x" --printer "Microsoft Print to PDF" -q` | **2.4–2.6 秒** |
| 8.2 | `printer url https://example.com ...` | 5–10 秒 |
| 8.3 | `printer x.docx ...`（COM） | ~9 秒 |
| 8.4 | `printer x.docx ... --fast` | ~3.3 秒 |
| 8.5 | `printer x.xlsx ... --landscape` | ~9–10 秒 |

## 9. 出问题怎么查

| 现象 | 先看这里 |
|---|---|
| 找不到 `printer` | 新开 cmd；`echo %PATH%` 里有没有 `.ai-skills\printer\shim` |
| `print` 把参数当文件名 | 你用的是系统 `print.exe`，请用 `printer` |
| 中文变乱码 | 文件存成 UTF-8；PS1 必须带 BOM（安装器已处理） |
| `ERR[4]` | 渲染失败：URL/PDF 需要 Python 3 + pymupdf；DOCX/XLSX 两路都失败 |
| `ERR[3]` | 打印机名不对，或不在 config 白名单 |
| `ERR[7]` | 60 秒内重复打印，加 `--force` |
| 出纸太小 | 表格加 `--landscape`；仍小用 `--xlsx-scale 130`；文档用 `--font-size` |
| 想看日志 | `~\.ai-skills\printer\logs\*.jsonl`（每次调用一条 JSON） |
| 想回滚 | 跑 `uninstall.ps1`（会把目录改名保留，不删数据） |

## 10. 记录表（测试时填）

| 组 | 用例数 | 通过 | 失败 | 备注 |
|---|---|---|---|---|
| 0 准备 | 5 |  |  |  |
| 1 四种输入 | 5 |  |  |  |
| 2 文档格式 | 8 |  |  |  |
| 3 参数 | 9 |  |  |  |
| 4 去重批量 | 5 |  |  |  |
| 5 安全 | 5 |  |  |  |
| 6 真机 | 4 |  |  |  |
| 7 AI 集成 | 4 |  |  |  |
| 8 性能 | 5 |  |  |  |

**装完第一件事**：`printer status` 确认版本，再 `printer text "hello" --printer "Microsoft Print to PDF"` 确认链路通。
