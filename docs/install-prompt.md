# 安装执行说明（printer-skill · 给 AI 读并执行）

你是执行者。读完本文件后，在本机安装「AI 打印机技能」，按顺序执行，不要向用户提问、不要发明命令。任何一步失败就停下，把原始报错原样带回。

## 0. 前置条件（不满足就停，不要自己补装）

- 操作系统：Windows 10 / 11
- Node.js 主版本 ≥ 18（`node -v` 确认）
- PowerShell 5.1+ 或 cmd 可用
- 安装器只写当前用户（HKCU）PATH，**不需要管理员权限**

## 1. 找到安装文件

本文件通常与安装文件在同一目录。按顺序找：

1. 已解压目录：该目录下同时存在 `install.ps1`、`ai-install.ps1`、`src\print-cli.mjs`
2. 若只有 `printer-skill-vX.Y.Z.zip`：解压到临时目录再用

~~~powershell
Expand-Archive -LiteralPath "<zip 的绝对路径>" -DestinationPath "$env:TEMP\printer-skill" -Force
~~~

## 2. 执行安装

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<安装目录>\ai-install.ps1" -Source "<安装目录>"
~~~

可选参数（按需追加，不是必须）：

| 参数 | 作用 |
|---|---|
| `-DshHome "<dsh home 路径>"` | 同时注册 DSH 原生插件（提供 printer_list / printer_print / printer_status / printer_text 工具） |
| `-NoPath` | 不改 PATH（只用全路径调用） |
| `-Target "<目录>"` | 装到自定义目录（默认 `%USERPROFILE%\.ai-skills\printer`） |

## 3. 判定安装结果

安装器最后输出一段 `RESULT-JSON`：

~~~json
{ "ok": true, "target": "...", "steps": [ { "step": "check-node", "status": "OK" }, ... ] }
~~~

- `ok: true` → 进入第 4 步
- `ok: false` → 找到 `steps` 里 `status: "FAIL"` 的那一项，按第 6 节处置；处置不了就停

## 4. 验证（必须做，三条，缺一不可）

**必须新开一个 cmd/PowerShell 窗口**（旧窗口的 PATH 不生效）。

~~~cmd
where printer
printer status
printer "<安装目录>RELEASE.md" --printer "Microsoft Print to PDF" --dry-run
~~~

通过标准：

1. `where printer` 指向 `...\.ai-skills\printer\shim\printer.cmd`，且**不是** `C:\Windows\System32\...`
2. `printer status` 第一行是 `print-cli 1.3.x`（或更高）
3. 第三条输出 `DRY-RUN OK`（不产生 PDF、不进打印队列）

## 5. 可选：同步安装到 AI 宿主

如果这台机器上跑着 DSH 或 WorkBuddy，**重跑一次安装器**并带上对应开关，它会把「技能」和「插件/MCP」一起装好：

~~~powershell
# DSH（把 <home> 换成含 profiles\ 的那一层，例如 %USERPROFILE%\.dsh）
powershell -NoProfile -ExecutionPolicy Bypass -File "<安装目录>\install.ps1" -Source "<安装目录>" -WithDsh -DshHome "<home>"

# WorkBuddy（默认 %USERPROFILE%\.workbuddy）
powershell -NoProfile -ExecutionPolicy Bypass -File "<安装目录>\install.ps1" -Source "<安装目录>" -WithWorkBuddy

# 两个都要
powershell -NoProfile -ExecutionPolicy Bypass -File "<安装目录>\install.ps1" -Source "<安装目录>" -WithDsh -DshHome "<home>" -WithWorkBuddy
~~~

| 开关 | 装什么 | 生效方式 |
|---|---|---|
| `-WithDsh` | 插件 `@local/printer`（4 个工具）+ `<home>\skills\printer\SKILL.md` + `cordis.patch.yml` 注册段 | 技能热加载；**插件需重启 dsh** |
| `-WithWorkBuddy` | `<.workbuddy>\skills\printer\SKILL.md` + `mcp.json` 的 `printer`（stdio） | **需重启 WorkBuddy** |

两者都幂等：重复执行只更新有变化的文件；`cordis.patch.yml` / `mcp.json` 改前会备份成 `.bak-<时间戳>`。
如果宿主目录不存在，安装器会明确报错并退出，不会写到别处。

只想用 MCP、不装技能时，也可以用：`mcp\register-mcp.ps1 -Agent all`。

## 6. 失败处置

| FAIL 的项 | 原因 | 处置 |
|---|---|---|
| `check-node` | 没有 Node 或 < 18 | 停止，告知用户需先装 Node LTS |
| `locate` | 路径不对 | 确认目录里有 `install.ps1` 与 `src\print-cli.mjs` |
| `install` | 复制失败/被占用 | 关掉占用进程后重跑；或换 `-Target` 目录 |
| `verify-printers` | shim 起不来 | 用全路径试 `"%USERPROFILE%\.ai-skills\printer\shim\printer.cmd" printers` |
| `verify-dryrun` | 白名单里没有 PDF 打印机 | 检查 `config.json` 的 `printers.allow`，必须含 `Microsoft Print to PDF` |
| `verify-path` | PATH 未生效 | 新开窗口；仍不行重跑 `install.ps1 -AddToPath` |
| `verify-no-print-shadow` | PATH 上有旧 `print.cmd` | 用本包安装器重装（会把旧文件改名为 `.bak-<时间戳>`） |

## 7. 红线（违反任何一条都算失败）

1. 不要打印真机（会耗纸）——验证只用 `Microsoft Print to PDF`
2. 不要修改系统默认打印机
3. 不要安装驱动、不要点系统弹窗
4. 不要删除任何文件（安装器自身也只改名不删除）
5. 不要改系统级环境变量或 HKLM 注册表
6. 不要把 `print` 当成命令名使用（那是 Windows 自带程序，参数会被当文件名）

## 8. 回报格式（装完按这个回）

~~~text
【安装结果】ok = true / false
【版本】print-cli x.y.z
【安装目录】C:\...
【验证 1】where printer → <原始输出>
【验证 2】printer status → <第一行>
【验证 3】dry-run → <最后一行>
【失败】哪一步 + 原始报错（如有）
【未做】哪些可选项没做、为什么
~~~
