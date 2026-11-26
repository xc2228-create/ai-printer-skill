#Requires -Version 5.1
<#
.SYNOPSIS
    AI 打印机技能安装器（Windows PowerShell 5.1 / PowerShell 7，幂等）。

.DESCRIPTION
    把 src\、shim\、SKILL.md、config.example.json、uninstall.ps1 安装到 -Target，
    可选把 shim 目录加入用户级 PATH，可选把 DSH 插件 @local/printer 装进 DSH home。
    入口命令名是 printer。print 是 Windows 自带命令（System32\print.exe，永远排在
    用户 PATH 前面），本技能不使用、也不占用 print。
    已有文件不删除：覆盖前改名为 *.bak-<时间戳>。
    全程不修改系统级环境变量，不安装驱动，不改系统默认打印机。

.PARAMETER Target
    安装目录。默认 "$env:USERPROFILE\.ai-skills\printer"。

.PARAMETER AddToPath
    把 <Target>\shim 追加到用户级 PATH（HKCU\Environment，去重；不加系统级）。

.PARAMETER WithDsh
    额外安装 DSH 插件 @local/printer（4 个工具），把技能说明放到 <DshHome>\skills\printer\SKILL.md，
    并在 <DshHome>\profiles\<DshProfile>\cordis.patch.yml 末尾追加注册段（先备份）。

.PARAMETER WithWorkBuddy
    额外安装 WorkBuddy 技能：把 SKILL.md 放到 <WorkBuddyHome>\skills\printer\，
    并在 <WorkBuddyHome>\mcp.json 注册 printer（stdio，指向本技能自带的 printer-mcp.mjs）。
    mcp.json 改前会备份为 mcp.json.bak-<时间戳>。

.PARAMETER WorkBuddyHome
    WorkBuddy 数据目录，默认 $env:USERPROFILE\.workbuddy。

.PARAMETER DryRun
    只打印将要做什么：不写文件、不改 PATH、不改注册表、不复制插件。

.PARAMETER DshHome
    DSH home 目录（存放 profiles\ 的那一层）。默认取 $env:DSH_HOME，否则 $env:USERPROFILE\.dsh。
    DSH 实例请显式传 -DshHome（例如 $env:USERPROFILE\.dsh\home。

.PARAMETER DshProfile
    DSH profile 名，默认 web。

.PARAMETER Source
    技能源目录，默认为本脚本所在目录。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AddToPath -WithDsh -DshHome "$env:USERPROFILE\.dsh" -WithWorkBuddy
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Target D:\tools\printer -WithDsh -DshHome C:\Users\me\.dsh
#>
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:USERPROFILE '.ai-skills\printer'),
    [switch]$AddToPath,
    [switch]$WithDsh,
    [switch]$WithWorkBuddy,
    [string]$WorkBuddyHome,
    [switch]$DryRun,
    [string]$DshHome = '',
    [string]$DshProfile = 'web',
    [string]$Source = '',
    # 双击/右击运行时让窗口停住，方便看输出；命令行与自动化默认不停
    [switch]$Pause,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$nl = [string]([char]13) + [string]([char]10)

$script:Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Started = Get-Date
$script:Log = New-Object System.Collections.ArrayList
$script:PathState = '未处理'
$script:PathDiff = ''
$script:DshState = '未安装（未指定 -WithDsh）'
$script:WbState = '未安装（未指定 -WithWorkBuddy）'
$script:DshDetail = New-Object System.Collections.ArrayList
$script:Backups = New-Object System.Collections.ArrayList

function Say {
    param([string]$Text)
    [void]$script:Log.Add($Text)
    Write-Output $Text
}

function Resolve-FullPath {
    param([string]$Path)
    $unresolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($unresolved)
}

function Get-NodeInfo {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $cmd) { return $null }
    $raw = & $cmd.Source -v 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$raw)) { return $null }
    $text = ([string]$raw).Trim()
    $m = [regex]::Match($text, '^v?(\d+)\.(\d+)\.(\d+)')
    if (-not $m.Success) { return $null }
    $major = [int]$m.Groups[1].Value
    return [pscustomobject]@{
        Path    = $cmd.Source
        Version = $text
        Major   = $major
        Ok      = ($major -ge 18)
    }
}

function Get-PrinterSnapshot {
    try {
        return @(Get-Printer -ErrorAction Stop | Sort-Object Name | ForEach-Object {
            [pscustomobject]@{ Name = [string]$_.Name; Status = [string]$_.PrinterStatus }
        })
    } catch {
        try {
            return @(Get-CimInstance Win32_Printer -ErrorAction Stop | Sort-Object Name | ForEach-Object {
                [pscustomobject]@{ Name = [string]$_.Name; Status = [string]$_.PrinterStatus }
            })
        } catch {
            return @()
        }
    }
}

function Get-Whitelist {
    param([string]$ConfigPath, [string]$ExamplePath)
    $path = $null
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { $path = $ConfigPath }
    elseif (Test-Path -LiteralPath $ExamplePath -PathType Leaf) { $path = $ExamplePath }
    if ($null -eq $path) { return @() }
    try {
        $json = [System.IO.File]::ReadAllText($path, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
        if ($null -ne $json.printers -and $null -ne $json.printers.allow) {
            return @($json.printers.allow | ForEach-Object { [string]$_ })
        }
    } catch { }
    return @()
}

function Get-UserPathState {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($null -eq $key) {
        return [pscustomobject]@{ Exists = $false; Value = ''; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
    }
    try {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try { $kind = $key.GetValueKind('Path') } catch { }
        $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) {
            return [pscustomobject]@{ Exists = $false; Value = ''; Kind = $kind }
        }
        return [pscustomobject]@{ Exists = $true; Value = [string]$value; Kind = $kind }
    } finally {
        $key.Close()
    }
}

function Set-UserPathValue {
    param([string]$Value, [Microsoft.Win32.RegistryValueKind]$Kind)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    }
    try {
        $key.SetValue('Path', [string]$Value, $Kind)
    } finally {
        $key.Close()
    }
}

function Split-PathList {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
    return @($Value -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Test-PathListContains {
    param([string[]]$Entries, [string]$Needle)
    $n = $Needle.Trim().TrimEnd('\')
    foreach ($entry in $Entries) {
        $expanded = [Environment]::ExpandEnvironmentVariables($entry).Trim().TrimEnd('\')
        if ([string]::Equals($expanded, $n, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Send-EnvironmentChanged {
    try {
        if (-not ('Win32.NativeMethods' -as [type])) {
            Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        [System.UIntPtr]$result = [System.UIntPtr]::Zero
        [void][Win32.NativeMethods]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    } catch {
        Write-Output "  [提示] 环境变量广播失败（不致命）：$($_.Exception.Message)"
    }
}

function Get-UniqueBackupPath {
    param([string]$Path, [string]$Stamp)
    $candidate = "$Path.bak-$Stamp"
    $i = 2
    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.bak-$Stamp-$i"
        $i++
    }
    return $candidate
}

function Get-InstallItems {
    param([string]$Root)
    $items = New-Object System.Collections.ArrayList
    foreach ($dir in @('src', 'shim', 'mcp')) {
        $dirPath = Join-Path $Root $dir
        if (-not (Test-Path -LiteralPath $dirPath -PathType Container)) {
            throw "源目录缺少 $dir\：$dirPath"
        }
        foreach ($file in @(Get-ChildItem -LiteralPath $dirPath -Recurse -Force -File)) {
            $rel = $file.FullName.Substring($Root.Length).TrimStart('\')
            [void]$items.Add([pscustomobject]@{ Rel = $rel; Src = $file.FullName })
        }
    }
    foreach ($fileName in @('SKILL.md', 'config.example.json', 'uninstall.ps1')) {
        $filePath = Join-Path $Root $fileName
        if (Test-Path -LiteralPath $filePath -PathType Leaf) {
            [void]$items.Add([pscustomobject]@{ Rel = $fileName; Src = $filePath })
        } elseif ($fileName -ne 'uninstall.ps1') {
            throw "源目录缺少文件：$filePath"
        }
    }
    return @($items)
}

function Write-Utf8File {
    param([string]$Path, [string]$Content, [bool]$WithBom = $true)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $enc = New-Object System.Text.UTF8Encoding($WithBom)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

function Read-Utf8File {
    param([string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $text = [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ Text = $text; HasBom = $hasBom }
}

# ---------------------------------------------------------------------------
# 0. 参数与源目录
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Source)) { $Source = $PSScriptRoot }
$Source = Resolve-FullPath $Source
$Target = Resolve-FullPath $Target

$mode = '实际安装'
if ($DryRun) { $mode = 'DryRun（演练，不落盘）' }
Say ''
Say '============================================================'
Say " AI 打印机技能 安装器   $($script:Started.ToString('yyyy-MM-dd HH:mm:ss'))"
Say " 模式：$mode"
Say " 源目录：$Source"
Say " 目标：  $Target"
Say '============================================================'
Say ''

if (-not (Test-Path -LiteralPath (Join-Path $Source 'src\print-cli.mjs') -PathType Leaf)) {
    Say "[失败] 源目录不是技能包根目录（缺少 src\print-cli.mjs）：$Source"
    exit 1
}
if ([string]::Equals($Target.TrimEnd('\'), $Source.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Say '[失败] -Target 不能等于源目录：安装会覆盖源码本身。'
    exit 1
}
if ($Source.StartsWith($Target.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    Say '[失败] -Target 是源目录的上级，拒绝安装（会覆盖源码）。'
    exit 1
}

# ---------------------------------------------------------------------------
# 1. Node 运行时检查
# ---------------------------------------------------------------------------
Say '[1/6] 检查 Node.js 运行时'
$node = Get-NodeInfo
if ($null -eq $node) {
    Say '  [失败] 未找到 node.exe。请先安装 Node.js 18 或更高版本：https://nodejs.org/'
    Say '         安装后重开一个命令行窗口，再运行本脚本。'
    exit 1
}
if (-not $node.Ok) {
    Say "  [失败] Node $($node.Version) 太旧，本技能要求 >= 18。"
    exit 1
}
Say "  OK  node $($node.Version)  ($($node.Path))"

# ---------------------------------------------------------------------------
# 2. 复制文件（覆盖前先备份）
# ---------------------------------------------------------------------------
Say ''
Say '[2/6] 复制技能文件到目标目录'
$items = Get-InstallItems -Root $Source
$copied = 0
$backedUp = 0
$unchanged = 0
foreach ($item in $items) {
    $dest = Join-Path $Target $item.Rel
    $exists = Test-Path -LiteralPath $dest
    # 内容相同则不备份、不覆盖（避免反复安装堆积 *.bak-*）
    $same = $false
    if ($exists -and -not $DryRun) {
        try {
            $same = ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash -eq
                     (Get-FileHash -LiteralPath $item.Src -Algorithm SHA256).Hash)
        } catch { $same = $false }
    }
    if ($DryRun) {
        $note = ''
        if ($exists) { $note = '  (已存在 → 内容不同才备份为 *.bak-' + $script:Stamp + ')' }
        Say "  [计划] $($item.Rel)$note"
        continue
    }
    if ($same) {
        $unchanged++
        Say "  [跳过] $($item.Rel) 内容未变"
        continue
    }
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
    if ($exists) {
        $backup = Get-UniqueBackupPath -Path $dest -Stamp $script:Stamp
        Move-Item -LiteralPath $dest -Destination $backup -Force
        [void]$script:Backups.Add($backup)
        $backedUp++
        Say "  [备份] $($item.Rel) -> $(Split-Path -Leaf $backup)"
    }
    Copy-Item -LiteralPath $item.Src -Destination $dest -Force
    $copied++
}
if ($DryRun) {
    Say "  [计划] 共 $($items.Count) 个文件；已存在的文件先改名为 *.bak-$($script:Stamp)"
} else {
    Say "  已复制 $copied 个文件，备份 $backedUp 个旧文件，内容未变跳过 $unchanged 个"
}

# 旧版本（1.0.0）的入口叫 shim\print.cmd —— 与 Windows 自带的 print.exe 撞名，
# 在 PATH 上永远不会被命中。安装时把它改名清走（改名，不删除），避免继续误导。
$staleShim = Join-Path $Target 'shim\print.cmd'
if (Test-Path -LiteralPath $staleShim -PathType Leaf) {
    if ($DryRun) {
        Say "  [计划] 旧入口 shim\print.cmd 改名为 print.cmd.bak-$($script:Stamp)（print 是 Windows 自带命令，本技能用 printer）"
    } else {
        $staleBackup = Get-UniqueBackupPath -Path $staleShim -Stamp $script:Stamp
        Move-Item -LiteralPath $staleShim -Destination $staleBackup -Force
        [void]$script:Backups.Add($staleBackup)
        Say "  [改名] 旧入口 shim\print.cmd -> $(Split-Path -Leaf $staleBackup)（print 是 Windows 自带命令，本技能用 printer）"
    }
}

# ---------------------------------------------------------------------------
# 3. config.json
# ---------------------------------------------------------------------------
Say ''
Say '[3/6] 准备 config.json'
$configPath = Join-Path $Target 'config.json'
$examplePath = Join-Path $Source 'config.example.json'
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    Say '  [跳过] config.json 已存在，保留现有配置（不覆盖、不备份）'
} elseif ($DryRun) {
    Say '  [计划] 从 config.example.json 复制出 config.json'
} else {
    $destDir = Split-Path -Parent $configPath
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
    Copy-Item -LiteralPath $examplePath -Destination $configPath -Force
    Say '  [新建] config.json（来源：config.example.json，白名单 = Microsoft Print to PDF + 占位打印机）'
}

# ---------------------------------------------------------------------------
# 4. 用户级 PATH
# ---------------------------------------------------------------------------
Say ''
Say '[4/6] 用户级 PATH'
$shimDir = Join-Path $Target 'shim'
$userPath = Get-UserPathState
$entries = Split-PathList $userPath.Value
$hasShim = Test-PathListContains -Entries $entries -Needle $shimDir
$newValue = $null
if (-not $AddToPath) {
    $script:PathState = '未启用（未指定 -AddToPath）'
    $script:PathDiff = '无变化'
    Say '  [跳过] 未指定 -AddToPath，不修改 PATH'
} elseif ($hasShim) {
    $script:PathState = '已存在，跳过（幂等）'
    $script:PathDiff = '无变化（已包含 ' + $shimDir + '）'
    Say "  [跳过] 用户级 PATH 已包含 $shimDir"
} else {
    $newEntries = @($entries) + $shimDir
    $newValue = ($newEntries -join ';')
    $script:PathDiff = '+ ' + $shimDir
    if ($DryRun) {
        $script:PathState = '将添加（DryRun 未执行）'
        Say "  [计划] 追加到 HKCU\Environment\Path：$shimDir"
        Say "  [计划] PATH 长度 $($userPath.Value.Length) -> $($newValue.Length) 字符；值类型 $($userPath.Kind)"
    } else {
        $script:PathState = '已添加'
        $kind = $userPath.Kind
        if ($kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString -and $kind -ne [Microsoft.Win32.RegistryValueKind]::String) {
            $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        }
        Set-UserPathValue -Value $newValue -Kind $kind
        Say "  [完成] 已追加：$shimDir"
        Send-EnvironmentChanged
        Say '  [提示] 已广播环境变量变更；已打开的命令行窗口需重开才生效。'
    }
}
if ($null -ne $newValue -and $newValue.Length -gt 2047) {
    Say "  [警告] 用户级 PATH 已达 $($newValue.Length) 字符，部分旧程序可能读不全。"
}

# ---------------------------------------------------------------------------
# 5. DSH 插件（可选）
# ---------------------------------------------------------------------------
Say ''
Say '[5/6] AI 宿主接入（DSH 插件+技能 / WorkBuddy 技能+MCP）'
if (-not ($WithDsh -or $WithWorkBuddy)) {
    Say '  [跳过] 未指定 -WithDsh / -WithWorkBuddy'
    $script:DshState = '未安装（未指定 -WithDsh）'
    $script:WbState = '未安装（未指定 -WithWorkBuddy）'
} else {
if ($WithDsh) {
    if ([string]::IsNullOrWhiteSpace($DshHome)) {
        $candidates = @()
        if ($env:DSH_HOME) { $candidates += $env:DSH_HOME }
        $candidates += (Join-Path $env:USERPROFILE '.dsh')
        foreach ($candidate in $candidates) {
            if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Container)) { $DshHome = $candidate; break }
        }
    }
    if ([string]::IsNullOrWhiteSpace($DshHome)) {
        Say '  [失败] 未找到 DSH home，请用 -DshHome 指定（例如沙盒：$env:USERPROFILE\.dsh\home）'
        exit 1
    }
    $DshHome = Resolve-FullPath $DshHome
    $profileDir = Join-Path $DshHome ("profiles\" + $DshProfile)
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
        Say "  [失败] 找不到 DSH 配置：$patchPath"
        Say '         请确认 -DshHome / -DshProfile 是否正确（-DshHome 指包含 profiles\ 的那一层）。'
        exit 1
    }
    $pluginSrc = Join-Path $Source 'plugin\@local\printer'
    if (-not (Test-Path -LiteralPath (Join-Path $pluginSrc 'lib\index.js') -PathType Leaf)) {
        Say "  [失败] 插件源缺失：$pluginSrc"
        exit 1
    }
    $pluginDest = Join-Path $DshHome 'profiles\node_modules\@local\printer'
    $cliPath = Join-Path $Target 'src\print-cli.mjs'
    $markerBegin = '# >>> ai-printer-skill (managed by install.ps1) >>>'
    $markerEnd = '# <<< ai-printer-skill <<<'
    $blockLines = @(
        $markerBegin
        '# AI 打印机技能：@local/printer 提供 printer_list / printer_print / printer_status 三个 tool。'
        '# 卸载：删掉本段与 profiles\node_modules\@local\printer，然后重启 dsh。'
        '- insert:'
        '    - id: printer'
        "      name: '@local/printer'"
        '      config:'
        "        cliPath: '$cliPath'"
        $markerEnd
    )
    $block = ($blockLines -join $nl) + $nl

    $patch = Read-Utf8File -Path $patchPath
    # 幂等：本安装器自己的标记段，或已存在任何形式的 @local/printer 注册，都算「已注册」
    $already = $patch.Text.Contains($markerBegin) -or ($patch.Text -match '@local/printer')

    if ($DryRun) {
        Say "  [计划] 插件目录：$pluginDest"
        if (Test-Path -LiteralPath $pluginDest) { Say "  [计划] 已存在的插件目录改名为 printer.bak-$($script:Stamp)，再复制新版" } else { Say '  [计划] 新建插件目录' }
        if ($already) {
            Say '  [计划] cordis.patch.yml 已含注册段，跳过追加（幂等）'
        } else {
            Say "  [计划] 备份 $patchPath -> cordis.patch.yml.bak-$($script:Stamp)"
            Say '  [计划] 追加以下内容到 cordis.patch.yml：'
            foreach ($line in $blockLines) { Say "    + $line" }
        }
        $script:DshState = 'DryRun（将安装）'
        [void]$script:DshDetail.Add("插件目录：$pluginDest")
        [void]$script:DshDetail.Add("配置段：$patchPath")
    } else {
        if (Test-Path -LiteralPath $pluginDest) {
            $pluginBackup = Get-UniqueBackupPath -Path $pluginDest -Stamp $script:Stamp
            Move-Item -LiteralPath $pluginDest -Destination $pluginBackup -Force
            Say "  [备份] 旧插件目录 -> $(Split-Path -Leaf $pluginBackup)"
        }
        New-Item -ItemType Directory -Path $pluginDest -Force | Out-Null
        Copy-Item -Path (Join-Path $pluginSrc '*') -Destination $pluginDest -Recurse -Force
        Say "  [完成] 插件已复制到 $pluginDest"
        if ($already) {
            Say '  [跳过] cordis.patch.yml 已含注册段（幂等）'
            $script:DshState = '已安装（配置段已存在，未重复追加）'
        } else {
            $patchBackup = Get-UniqueBackupPath -Path $patchPath -Stamp $script:Stamp
            Copy-Item -LiteralPath $patchPath -Destination $patchBackup -Force
            Say "  [备份] cordis.patch.yml -> $(Split-Path -Leaf $patchBackup)"
            $newText = $patch.Text
            if (-not $newText.EndsWith([string][char]10)) { $newText += $nl }
            $newText += $block
            Write-Utf8File -Path $patchPath -Content $newText -WithBom $patch.HasBom
            Say '  [完成] cordis.patch.yml 已追加注册段'
            $script:DshState = '已安装（配置段已追加）'
        }
        [void]$script:DshDetail.Add("插件目录：$pluginDest")
        [void]$script:DshDetail.Add("配置段：$patchPath")

        # 技能说明：DSH 的技能列表来自 <DshHome>\skills\<name>\SKILL.md
        # 只装插件的话，用户能在工具里看到 printer_*，但「技能」列表里没有它。
        $skillSrc = Join-Path $Target 'SKILL.md'
        $skillDir = Join-Path $DshHome 'skills\printer'
        if (Test-Path -LiteralPath $skillSrc) {
            New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
            $skillDest = Join-Path $skillDir 'SKILL.md'
            $needCopy = $true
            if (Test-Path -LiteralPath $skillDest) {
                $hashA = (Get-FileHash -LiteralPath $skillSrc -Algorithm SHA256).Hash
                $hashB = (Get-FileHash -LiteralPath $skillDest -Algorithm SHA256).Hash
                if ($hashA -eq $hashB) { $needCopy = $false }
            }
            if ($needCopy) {
                Copy-Item -LiteralPath $skillSrc -Destination $skillDest -Force
                Say "  [完成] 技能已放入 $skillDir"
            } else {
                Say '  [跳过] DSH 技能已是最新'
            }
            [void]$script:DshDetail.Add("技能目录：$skillDir")
        } else {
            Say '  [跳过] 没找到 SKILL.md，未安装 DSH 技能'
        }

        Say '  [注意] 插件工具需要重启 dsh（dsh web）后才会出现；技能目录会热加载。'
    }

    }

    if ($WithWorkBuddy) {
        if ([string]::IsNullOrWhiteSpace($WorkBuddyHome)) {
            $WorkBuddyHome = Join-Path $env:USERPROFILE '.workbuddy'
        }
        $WorkBuddyHome = Resolve-FullPath $WorkBuddyHome
        if (-not (Test-Path -LiteralPath $WorkBuddyHome -PathType Container)) {
            Say "  [失败] 找不到 WorkBuddy 目录：$WorkBuddyHome（用 -WorkBuddyHome 指定）"
            exit 1
        }
        $wbSkillSrc = Join-Path $Target 'SKILL.md'
        $wbSkillDir = Join-Path $WorkBuddyHome 'skills\printer'
        if (Test-Path -LiteralPath $wbSkillSrc) {
            New-Item -ItemType Directory -Force -Path $wbSkillDir | Out-Null
            $wbSkillDest = Join-Path $wbSkillDir 'SKILL.md'
            $wbNeed = $true
            if (Test-Path -LiteralPath $wbSkillDest) {
                if ((Get-FileHash -LiteralPath $wbSkillSrc -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $wbSkillDest -Algorithm SHA256).Hash) { $wbNeed = $false }
            }
            if ($DryRun) { Say "  [计划] 复制 SKILL.md -> $wbSkillDir" }
            elseif ($wbNeed) { Copy-Item -LiteralPath $wbSkillSrc -Destination $wbSkillDest -Force; Say "  [完成] WorkBuddy 技能已放入 $wbSkillDir" }
            else { Say '  [跳过] WorkBuddy 技能已是最新' }
        } else {
            Say '  [跳过] 没找到 SKILL.md，未安装 WorkBuddy 技能'
        }

        $wbMcpPath = Join-Path $WorkBuddyHome 'mcp.json'
        $mcpServerPath = Join-Path $Target 'mcp\printer-mcp.mjs'
        if (-not (Test-Path -LiteralPath $mcpServerPath -PathType Leaf)) {
            Say "  [跳过] 缺 $mcpServerPath，无法注册 MCP"
            $script:WbState = '技能已装，MCP 未注册（缺 printer-mcp.mjs）'
        } else {
            $nodeExe = (Get-Command node).Source
            $cfg = [pscustomobject]@{ mcpServers = [pscustomobject]@{} }
            $cfgExisted = Test-Path -LiteralPath $wbMcpPath
            if ($cfgExisted) {
                $raw = [IO.File]::ReadAllText($wbMcpPath)
                $raw = $raw.TrimStart([char]0xFEFF)
                if (-not [string]::IsNullOrWhiteSpace($raw)) {
                    try { $cfg = $raw | ConvertFrom-Json }
                    catch {
                        $broken = Get-UniqueBackupPath -Path $wbMcpPath -Stamp $script:Stamp
                        Copy-Item -LiteralPath $wbMcpPath -Destination $broken -Force
                        Say "  [警告] mcp.json 不是合法 JSON，已备份为 $(Split-Path -Leaf $broken)，将新建"
                        $cfg = [pscustomobject]@{ mcpServers = [pscustomobject]@{} }
                    }
                }
            }
            if ($null -eq $cfg.mcpServers) {
                $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
            }
            $curEntry = $cfg.mcpServers.PSObject.Properties['printer']
            $wbSame = $false
            if ($curEntry) {
                $curValue = $curEntry.Value
                $curArgs = @($curValue.args)
                if ($curValue.command -eq $nodeExe -and $curArgs.Count -eq 1 -and $curArgs[0] -eq $mcpServerPath) { $wbSame = $true }
            }
            if ($wbSame) {
                Say '  [跳过] WorkBuddy mcp.json 已注册 printer（幂等）'
                $script:WbState = '已安装（技能 + MCP 已存在）'
            } elseif ($DryRun) {
                Say "  [计划] 在 $wbMcpPath 注册 printer (stdio)"
                $script:WbState = '演练（计划安装技能 + 注册 MCP）'
            } else {
                if ($cfgExisted) {
                    $mcpBackup = Get-UniqueBackupPath -Path $wbMcpPath -Stamp $script:Stamp
                    Copy-Item -LiteralPath $wbMcpPath -Destination $mcpBackup -Force
                    Say "  [备份] mcp.json -> $(Split-Path -Leaf $mcpBackup)"
                }
                $entry = [pscustomobject]@{
                    type    = 'stdio'
                    command = $nodeExe
                    args    = @($mcpServerPath)
                    env     = [pscustomobject]@{}
                }
                $cfg.mcpServers | Add-Member -NotePropertyName printer -NotePropertyValue $entry -Force
                $json = $cfg | ConvertTo-Json -Depth 10
                Write-Utf8File -Path $wbMcpPath -Content $json -WithBom $false
                Say '  [完成] WorkBuddy mcp.json 已注册 printer (stdio)'
                $script:WbState = '已安装（技能 + MCP）'
            }
            [void]$script:DshDetail.Add("WorkBuddy MCP：$wbMcpPath")
        }
        [void]$script:DshDetail.Add("WorkBuddy 技能：$wbSkillDir")
        Say '  [注意] WorkBuddy 需要重启后才会加载技能与 MCP。'
    }
}

# ---------------------------------------------------------------------------
# 6. 安装报告
# ---------------------------------------------------------------------------
Say ''
Say '[6/6] 安装报告'
$printers = Get-PrinterSnapshot
$whitelist = Get-Whitelist -ConfigPath $configPath -ExamplePath $examplePath
$reportPath = Join-Path $Target 'install-report.txt'

$report = New-Object System.Collections.ArrayList
[void]$report.Add('AI 打印机技能 安装报告')
[void]$report.Add('=' * 60)
[void]$report.Add("生成时间    : $($script:Started.ToString('yyyy-MM-dd HH:mm:ss'))")
[void]$report.Add("安装模式    : $mode")
[void]$report.Add("源目录      : $Source")
[void]$report.Add("目标目录    : $Target")
[void]$report.Add("Node        : $($node.Version)  ($($node.Path))")
[void]$report.Add('Node 要求   : >= 18   结果: OK')
[void]$report.Add('')
[void]$report.Add('检测到的打印机（Get-Printer / Win32_Printer）:')
if ($printers.Count -eq 0) {
    [void]$report.Add('  (无法枚举打印机：请检查 Spooler 服务)')
} else {
    foreach ($p in $printers) { [void]$report.Add("  - $($p.Name)  [$($p.Status)]") }
}
[void]$report.Add('')
[void]$report.Add('白名单（config.json printers.allow）:')
if ($whitelist.Count -eq 0) { [void]$report.Add('  (未读到白名单)') }
else { foreach ($w in $whitelist) { [void]$report.Add("  - $w") } }
[void]$report.Add('')
[void]$report.Add('用户级 PATH（HKCU\Environment\Path）:')
[void]$report.Add("  shim 目录 : $shimDir")
[void]$report.Add("  状态      : $($script:PathState)")
[void]$report.Add("  变更      : $($script:PathDiff)")
[void]$report.Add('')
[void]$report.Add('DSH 插件:')
[void]$report.Add("  状态      : $($script:DshState)")
[void]$report.Add('WorkBuddy 接入:')
[void]$report.Add("  状态      : $($script:WbState)")
foreach ($line in $script:DshDetail) { [void]$report.Add("  $line") }
[void]$report.Add('')
[void]$report.Add('验证命令（新开一个命令行窗口后执行，预期如下）:')
$printerCount = $printers.Count
[void]$report.Add('  注意: 命令名是 printer，不是 print。print 是 Windows 自带命令')
[void]$report.Add('        （C:\Windows\System32\print.exe；系统目录永远排在用户 PATH 前面），')
[void]$report.Add('        用 print 不会命中本技能，还可能真的把文件送到默认打印机。')
[void]$report.Add('  1) printer printers')
[void]$report.Add("     预期: 列出 $printerCount 台打印机（含 Microsoft Print to PDF），退出码 0")
[void]$report.Add('  2) printer "<文件>.txt" --printer "Microsoft Print to PDF" --dry-run')
[void]$report.Add('     预期: 输出 "DRY-RUN OK"，不产生 PDF，退出码 0')
[void]$report.Add('  3) printer print "<文件>.txt" --printer "Microsoft Print to PDF"')
[void]$report.Add('     预期: 输出 OK 与 PDF 路径（' + $Target + '\test-out），退出码 0；子命令 print 可省略')
[void]$report.Add('')
[void]$report.Add('回滚 / 卸载:')
[void]$report.Add('  powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Source 'uninstall.ps1') + '" -Target "' + $Target + '"')
[void]$report.Add('  备份的旧文件: 与原名同目录的 *.bak-<时间戳>，改名即可恢复')
[void]$report.Add('')
[void]$report.Add('本次安装动作日志（只保留动作行）:')
foreach ($line in $script:Log) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith('[') -or $trimmed.StartsWith('已复制')) { [void]$report.Add('  ' + $trimmed) }
}
[void]$report.Add('')

if ($DryRun) {
    Say '  [计划] 将写入 install-report.txt：'
    foreach ($line in $report) { Say "    | $line" }
    Say ''
    Say '============================================================'
    Say ' DryRun 完成：没有创建/修改任何文件，PATH 与注册表未被改动。'
    Say ' 去掉 -DryRun 即执行同一套动作。'
    Say '============================================================'
} else {
    Write-Utf8File -Path $reportPath -Content (($report -join $nl) + $nl) -WithBom $true
    Say "  [完成] $reportPath"
    Say ''
    Say '============================================================'
    Say ' 安装完成。下一步：'
    if ($script:PathState -eq '已添加') {
        Say '  1) 重开一个命令行窗口（PATH 已更新）'
    } else {
        Say "  1) 直接用 $shimDir\printer.cmd，或用 -AddToPath 重跑把 shim 加进 PATH"
    }
    Say '  2) 验证：printer printers   （命令名是 printer；print 是 Windows 自带命令，不要用）'
    Say '  3) 卸载：uninstall.ps1（见 install-report.txt）'
    Say '============================================================'
}

# 暂停：只有显式 -Pause 且未指定 -NoPause 时才停（自动化调用请加 -NoPause）
if ($Pause -and -not $NoPause) {
    Say ''
    Say '按回车键关闭本窗口…'
    try { [void](Read-Host '（回车继续）') } catch { Start-Sleep -Seconds 60 }
}

exit 0
