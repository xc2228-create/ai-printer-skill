<#
.SYNOPSIS
  AI 一键安装器（给 AI agent 用的唯一入口）：解压/定位安装包 → 安装 → 验证 → 输出 JSON 报告。
.DESCRIPTION
  只做「装好并证明装好了」这一件事。所有参数都有默认值，AI 直接跑即可。
  退出码：0 成功；2 参数/环境问题；3 安装失败；4 验证失败。
.PARAMETER Zip
  安装包 zip 路径（给了就先解压到临时目录）。
.PARAMETER Source
  已解压的包目录（含 install.ps1 与 src\print-cli.mjs）。不给则在脚本同级自动找。
.PARAMETER Target
  安装目标目录，默认 %USERPROFILE%\.ai-skills\printer。
.PARAMETER NoPath
  不修改用户级 PATH。
.PARAMETER DshHome
  DSH home（含 profiles\ 的那层）。给了就装 DSH 插件；不给则自动探测。
#>
[CmdletBinding()]
param(
  [string]$Zip,
  [string]$Source,
  [string]$Target,
  [switch]$NoPath,
  [string]$DshHome,
  [switch]$WithWorkBuddy,
  [string]$WorkBuddyHome
)
$ErrorActionPreference = 'Stop'
$script:Steps = New-Object System.Collections.ArrayList
function Step([string]$name, [string]$status, [string]$detail) {
  [void]$script:Steps.Add([pscustomobject]@{ step = $name; status = $status; detail = $detail })
  Write-Host ("  [{0}] {1} {2}" -f $status, $name, $detail)
}

Write-Host '=== AI 一键安装 · 打印机技能 ==='

# 0. 环境
try { $nodeV = (& node -v) 2>$null } catch { $nodeV = $null }
if (-not $nodeV) { Step 'check-node' 'FAIL' 'node not found'; Write-Host '需要 Node >= 18'; exit 2 }
$major = [int](($nodeV -replace '^v','') -split '\.')[0]
if ($major -lt 18) { Step 'check-node' 'FAIL' "node $nodeV < 18"; exit 2 }
Step 'check-node' 'OK' $nodeV

# 1. 定位安装源
$pkgRoot = $null
if ($Zip) {
  if (-not (Test-Path -LiteralPath $Zip)) { Step 'locate' 'FAIL' "zip not found: $Zip"; exit 2 }
  $pkgRoot = Join-Path $env:TEMP ('printer-skill-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Force -Path $pkgRoot | Out-Null
  Expand-Archive -LiteralPath $Zip -DestinationPath $pkgRoot -Force
  Step 'locate' 'OK' "extracted to $pkgRoot"
} elseif ($Source) {
  $pkgRoot = $Source
} else {
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  foreach ($cand in @($here, (Join-Path $here '.') )) {
    if (Test-Path (Join-Path $cand 'install.ps1')) { $pkgRoot = $cand; break }
  }
}
if (-not $pkgRoot -or -not (Test-Path (Join-Path $pkgRoot 'install.ps1'))) {
  Step 'locate' 'FAIL' 'install.ps1 not found (pass -Zip or -Source)'; exit 2
}
Step 'locate' 'OK' $pkgRoot

# 2. 安装
$installArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $pkgRoot 'install.ps1'), '-NoPause')
if ($Target) { $installArgs += @('-Target', $Target) }
if (-not $NoPath) { $installArgs += '-AddToPath' }
if (-not $Target) { $Target = Join-Path $env:USERPROFILE '.ai-skills\printer' }

# 只在你显式给 -DshHome 时安装 DSH 插件；不自动探测，避免装进无关实例
if ($DshHome) { $installArgs += @('-WithDsh','-DshHome',$DshHome) }
if ($WithWorkBuddy) { $installArgs += '-WithWorkBuddy' }
if ($WorkBuddyHome) { $installArgs += @('-WorkBuddyHome',$WorkBuddyHome) }

$out = & powershell @installArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Step 'install' 'FAIL' "exit=$LASTEXITCODE"
  Write-Host ($out -split "`n" | Select-Object -Last 12)
  exit 3
}
$installDetail = "target=" + $Target
if ($DshHome) { $installDetail = $installDetail + " dsh=" + $DshHome }
Step 'install' 'OK' $installDetail

# 3. 验证
# 命令名是 printer（不是 print）：print 是 Windows 自带命令，System32 永远排在用户
# PATH 前面，用 print 会命中系统命令。按命令名 + PATH 解析来验证，不用绝对路径 ——
# 绝对路径会绕过 PATH 遮蔽，验不出命名冲突。
$shim = Join-Path $Target 'shim\printer.cmd'
$shimDir = Join-Path $Target 'shim'
$report = Join-Path $Target 'install-report.txt'
$v1 = $null; $v2 = $null; $wherePrinter = ''; $wherePrint = ''
if (Test-Path $shim) {
  $savedPath = $env:PATH
  $env:PATH = $shimDir + ';' + $savedPath
  try {
    $v1 = (cmd /c 'printer printers') 2>&1 | Out-String
    $exit1 = $LASTEXITCODE
    $demo = Join-Path $Target 'SKILL.md'
    if (-not (Test-Path $demo)) { $demo = Join-Path $Target 'README.md' }
    # 省略 print 子命令的写法
    $line2 = 'printer "' + $demo + '" --printer "Microsoft Print to PDF" --dry-run'
    $v2 = (cmd /c $line2) 2>&1 | Out-String
    $exit2 = $LASTEXITCODE
    $wherePrinter = (cmd /c 'where printer') 2>&1 | Out-String
    $wherePrint = (cmd /c 'where print') 2>&1 | Out-String
  } finally {
    $env:PATH = $savedPath
  }
} else { $exit1 = -1; $exit2 = -1 }

$okPrinters = ($exit1 -eq 0) -and ($v1 -match 'WHITELIST')
$okDry = ($exit2 -eq 0) -and ($v2 -match 'DRY-RUN OK')
$okPath = $wherePrinter.IndexOf($shimDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
$okNoShadow = $wherePrint.IndexOf($shimDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0
Step 'verify-printers' ($(if ($okPrinters) {'OK'} else {'FAIL'})) ("exit=$exit1  (printer printers)")
Step 'verify-dryrun'   ($(if ($okDry) {'OK'} else {'FAIL'})) ("exit=$exit2  (printer <file> --dry-run, subcommand omitted)")
Step 'verify-path'     ($(if ($okPath) {'OK'} else {'FAIL'})) ("where printer -> " + ($wherePrinter.Trim() -split "`r?`n" | Select-Object -First 1))
Step 'verify-no-print-shadow' ($(if ($okNoShadow) {'OK'} else {'FAIL'})) ("where print -> " + ($wherePrint.Trim() -split "`r?`n" | Select-Object -First 1))

# 4. 报告
$json = [pscustomobject]@{
  ok = ($okPrinters -and $okDry -and $okPath -and $okNoShadow)
  target = $Target
  node = $nodeV
  dshHome = $DshHome
  installReport = $report
  printersExit = $exit1
  dryRunExit = $exit2
  wherePrinter = ($wherePrinter.Trim() -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1)
  wherePrint = ($wherePrint.Trim() -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1)
  steps = $script:Steps
}
Write-Host ''
Write-Host '=== RESULT-JSON ==='
$json | ConvertTo-Json -Depth 4
if ($json.ok) { Write-Host 'RESULT: 安装并验证通过'; exit 0 } else { Write-Host 'RESULT: 验证失败'; exit 4 }
