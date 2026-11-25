# v1.4.0（2026-11-26）

## 新增：一步同步安装到 AI 宿主（DSH / WorkBuddy）

- **`-WithDsh`**：之前只装插件（工具），现在**同时**把技能说明放到 `<DshHome>\skills\printer\SKILL.md`
  —— 否则用户能在工具列表看到 `printer_*`，但「技能」列表里没有它
- **`-WithWorkBuddy`**（新）：安装 `<WorkBuddyHome>\skills\printer\SKILL.md`，并在
  `<WorkBuddyHome>\mcp.json` 注册 `printer`（stdio，指向自带的 `mcp\printer-mcp.mjs`）
- **`-WorkBuddyHome`**（新）：指定非默认的 WorkBuddy 目录
- `ai-install.ps1` 新增 `-WithWorkBuddy` / `-WorkBuddyHome` 透传
- 两者都**幂等**：重复执行只更新有变化的文件；`cordis.patch.yml` / `mcp.json` 改前备份为 `.bak-<时间戳>`
- `-DryRun` 可先预览会写哪些文件

## 修复

- `--fit-pages` 未达成目标页数时返回**退出码 2**（输出 `WARN[2] ... 没压进 N 页`），不再静默当成功
- 网页打印的临时 Chrome profile 若被占用没删掉，下次网页打印会自动清理**超过 30 分钟**的残留

---

# 打印机技能 v1.1.0（2026-11-23）

Windows 上的「打印技能」：AI 收到「把这个打出来」时，能查打印机、选打印机、出纸或落 PDF。

## 双击安装（给人用，窗口不会闪退）

解压后**双击 `install.cmd`** —— 它会跑安装并在结束时停住等你按回车，能看清每一步输出。

也可以传参数：`install.cmd -DryRun`、`install.cmd -AddToPath -WithDsh -DshHome "C:\Users\<you>\.dsh\home"`。

> 直接右击 `install.ps1` →「使用 PowerShell 运行」也可以装，但窗口跑完会立刻关掉，
> 想留窗口请用 `install.cmd`，或加 `-NoExit`。

## 一键安装（给 AI 用）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ai-install.ps1 -Zip "printer-skill-v1.1.0.zip"
```

它自己解压、安装、验证，最后输出 `RESULT-JSON`，`ok: true` 即成功。

常用组合：

| 目的 | 命令 |
|---|---|
| 只装文件 | `ai-install.ps1 -Zip <zip> -NoPath` |
| 装文件 + 加 PATH | `ai-install.ps1 -Zip <zip>` |
| 再装 DSH 插件 | `ai-install.ps1 -Zip <zip> -DshHome "<DSH home>"` |
| 指定位置 | `ai-install.ps1 -Zip <zip> -Target "D:\tools\printer" -NoPath` |

## 手动安装（不信任一键脚本时）

`install.ps1` 支持 `-DryRun`（只演练）、`-AddToPath`、`-WithDsh -DshHome`、`-Target`。

## 命令名（必读）

> ⚠️ 本技能的命令是 **`printer`**，**不是 `print`**。
> `print` 是 Windows 自带命令（`C:\Windows\System32\print.exe`），系统目录在 PATH 上永远排在
> 用户 PATH 前面，所以旧版的 `print.cmd` 从来没被命中过 —— 敲 `print x.txt --printer "..."`
> 跑的是系统命令，它会把 `--printer`、`--dry-run` 当文件名，**可能真的打到默认打印机**。
> v1.0.1 起入口改名 `printer.cmd`，旧的 `shim\print.cmd` 已删除（安装器遇到旧文件会改名清走）。

## 1.1.0 变更（P4「秒打」）

1. **纯文本输入**：`printer text "..."`；第一个参数既不是已存在文件、也不是 URL 时自动按文字打印（`--file` 可强制按文件解释）。
2. **URL 输入**：`printer url <http(s)://...>` —— Edge 无头 `--print-to-pdf`（轮询文件出现，60s 超时）+ pymupdf 200dpi 逐页 PNG + 现有图片打印；缺 Python 3/pymupdf 时退出码 4。
3. **静默输出**：`--quiet` / `-q` 只回一行 `OK 1p 3.2s -> <打印机>`（失败 `ERR[码] ...`）；`--json` 新增 `resultLine`。
4. **批量**：一次多个输入（`text:` / `url:` 前缀 + 路径），顺序执行、遇错不中断、汇总 `OK 2/3 (1 failed)`、退出码取第一个失败码。
5. **去重**：`sha256(渲染后内容)+printer+copies+paper+landscape`，60 秒内重复 → 退出码 **7**，`--force` 跳过，`--dedupe <秒>` 可调（0 关闭），状态在 `logs\.dedupe.json`（原子写）；dry-run 不参与。
6. **版式质量**：微软雅黑 10.5pt、行距 1.5、边距 20mm（`--font-size` / `--margin`）；Markdown 1/2/3 级标题 16/14/12.5pt、列表「· 」；图片等比居中且不放大超过原尺寸 100%；页脚 `文件名 · 第 x/y 页`。

测试：`node test/run-tests.mjs` 26 项全通过（新增 text / 裸文字 / quiet / 批量 / url / 标题字号 / 版式参数 / resultLine）；只用 `Microsoft Print to PDF`，HP 队列前后 0，默认打印机未改。

## 1.0.1 变更

1. **命令改名**：`shim\print.cmd` → `shim\printer.cmd`（`where printer` 为空，不撞任何 Windows 内置命令）。
2. **子命令可省略**：`printer <文件> --printer "..."` 与 `printer print <文件> --printer "..."` 等价；旧文档少写了一层子命令，照抄会 `ERROR[2]: unknown command`。
3. 安装器/一键安装器改用 `printer` 验证，并且**按命令名经 PATH 解析**验证（不再用绝对路径绕过遮蔽）：一键安装器新增 `verify-path` 与 `verify-no-print-shadow` 两步。
4. 测试新增：经 PATH 解析 `printer printers`、省略子命令的 `--dry-run`；`printer --bogus` 仍为 exit 2。

## 支持

- 格式：.txt .md .png .jpg .jpeg
- 打印机：必须显式指定 `--printer`，**从不使用系统默认**
- 安全：拒绝 .exe/.bat/.cmd/.ps1/.msi/.vbs/.scr；拒绝 Fax；份数上限 5

## 验证

```
printer printers
printer "测试.txt" --printer "Microsoft Print to PDF" --dry-run
printer print "测试.txt" --printer "Microsoft Print to PDF" --dry-run   # 等价写法
```

## 卸载

`uninstall.ps1`：从 PATH 摘除，安装目录改名为 `.removed-<时间戳>`（不删除）。