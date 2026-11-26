#Requires -Version 5.1
<#
.SYNOPSIS
    AI 打印机技能卸载器（Windows PowerShell 5.1 / PowerShell 7）。

.DESCRIPTION
    1) 把 <Target>\shim 从用户级 PATH 移除（若曾经加过；只动 HKCU，不动系统级）。
    2) 把 <Target> 整个目录移动到 <Target>.removed-<时间戳>，不删除任何文件。
    3) 打印恢复说明。
    默认不碰 DSH 插件与 cordis.patch.yml，见下方"手动清理 DSH 插件"提示。

.PARAMETER Target
    安装目录，需与 install.ps1 的 -Target 一致。默认 "$env:USERPROFILE\.ai-skills\printer"。

.PARAMETER SkipPathRemoval
    只移动目录，不改 PATH。

.PARAMETER DryRun
    只打印将要做什么。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 -DryRun
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:USERPROFILE '.ai-skills\printer'),
    [switch]$SkipPathRemoval,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say {
    param([string]$Text)
    Write-Output $Text
}

function Resolve-FullPath {
    param([string]$Path)
    $unresolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($unresolved)
}

function Get-UserPathState {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    if ($null -eq $key) { return $null }
    try {
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        try { $kind = $key.GetValueKind('Path') } catch { }
        $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        if ($null -eq $value) { return $null }
        return [pscustomobject]@{ Value = [string]$value; Kind = $kind }
    } finally {
        $key.Close()
    }
}

function Set-UserPathValue {
    param([string]$Value, [Microsoft.Win32.RegistryValueKind]$Kind)
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    if ($null -eq $key) { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
    try { $key.SetValue('Path', [string]$Value, $Kind) } finally { $key.Close() }
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
    } catch { }
}

function Get-UniqueDirectoryPath {
    param([string]$Path, [string]$Suffix)
    $candidate = "$Path.$Suffix-$stamp"
    $i = 2
    while (Test-Path -LiteralPath $candidate) {
        $candidate = "$Path.$Suffix-$stamp-$i"
        $i++
    }
    return $candidate
}

$Target = Resolve-FullPath $Target
$shimDir = Join-Path $Target 'shim'
$mode = '实际卸载'
if ($DryRun) { $mode = 'DryRun（演练）' }

Say ''
Say '============================================================'
Say " AI 打印机技能 卸载器   $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Say " 模式：$mode"
Say " 目标：$Target"
Say '============================================================'
Say ''

# --- 1. 从用户级 PATH 移除 ------------------------------------------------
Say '[1/3] 用户级 PATH'
$pathRemoved = $false
if ($SkipPathRemoval) {
    Say '  [跳过] 指定了 -SkipPathRemoval'
} else {
    $state = Get-UserPathState
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace($state.Value)) {
        Say '  [跳过] HKCU\Environment\Path 不存在或为空'
    } else {
        $entries = @($state.Value -split ';' | Where-Object { $_.Trim() -ne '' })
        $needle = $shimDir.TrimEnd('\')
        $kept = New-Object System.Collections.ArrayList
        $removed = New-Object System.Collections.ArrayList
        foreach ($entry in $entries) {
            $expanded = [Environment]::ExpandEnvironmentVariables($entry).Trim().TrimEnd('\')
            if ([string]::Equals($expanded, $needle, [System.StringComparison]::OrdinalIgnoreCase)) {
                [void]$removed.Add($entry)
            } else {
                [void]$kept.Add($entry)
            }
        }
        if ($removed.Count -eq 0) {
            Say "  [跳过] 用户级 PATH 不含 $shimDir"
        } elseif ($DryRun) {
            Say "  [计划] 从 HKCU\Environment\Path 移除：$shimDir"
            Say "  [计划] 条目数 $($entries.Count) -> $($kept.Count)"
        } else {
            Set-UserPathValue -Value ($kept -join ';') -Kind $state.Kind
            $pathRemoved = $true
            Say "  [完成] 已从用户级 PATH 移除：$shimDir（条目数 $($entries.Count) -> $($kept.Count)）"
            Send-EnvironmentChanged
        }
    }
}

# --- 2. 目录改名而不是删除 ------------------------------------------------
Say ''
Say '[2/3] 移动安装目录（不删除）'
$removedDir = $null
if (-not (Test-Path -LiteralPath $Target)) {
    Say "  [跳过] 目录不存在：$Target"
} else {
    $removedDir = Get-UniqueDirectoryPath -Path $Target -Suffix 'removed'
    if ($DryRun) {
        Say "  [计划] 移动 $Target -> $removedDir"
    } else {
        try {
            Move-Item -LiteralPath $Target -Destination $removedDir -Force
            Say "  [完成] 已移动到 $removedDir"
        } catch {
            Say "  [失败] 移动失败：$($_.Exception.Message)"
            Say '         如果当前命令行窗口就在该目录内，请先 cd 到别处再运行。'
            exit 1
        }
    }
}

# --- 3. 恢复说明 ----------------------------------------------------------
Say ''
Say '[3/3] 恢复说明'
if ($null -ne $removedDir) {
    Say "  目录没有删除，只是改名："
    Say "    原目录 : $Target"
    Say "    现目录 : $removedDir"
    Say '  恢复步骤：'
    Say "    1) Rename-Item -LiteralPath '$removedDir' -NewName '$([System.IO.Path]::GetFileName($Target))'"
    Say "    2) 需要命令行直接可用时：重新运行 install.ps1 -AddToPath，或手动把 $shimDir 加进 HKCU\Environment\Path"
} else {
    Say '  没有需要恢复的安装目录。'
}
Say '  命令名是 printer（不是 Windows 自带的 print）：卸载后 printer 命令不再可用。'
if ($pathRemoved) {
    Say "  PATH 已移除：$shimDir"
}
Say ''
Say '  手动清理 DSH 插件（若装过 -WithDsh）：'
Say '    1) 编辑 <DshHome>\profiles\web\cordis.patch.yml，删掉 '
Say '       "# >>> ai-printer-skill" 与 "# <<< ai-printer-skill <<<" 之间的整段'
Say '    2) 把 <DshHome>\profiles\node_modules\@local\printer 改名（不要直接删）'
Say '    3) 重启 dsh（dsh web）'
Say ''
Say '  安装时备份过的旧文件保留在原地（*.bak-<时间戳>），改名即可恢复。'
Say '============================================================'

exit 0
