<#
.SYNOPSIS
  把打印机技能注册进已安装的 AI agent（WorkBuddy 技能目录 + MCP；DSH 技能目录 + MCP 客户端）。
.DESCRIPTION
  只做「注册」，不复制 CLI。默认 -DryRun 演练；-All 或 -Agent workbuddy/dsh 指定目标。
  幂等：已存在同名条目就跳过；所有被改动的配置文件先备份为 *.bak-<时间戳>。
.PARAMETER Agent
  workbuddy | dsh | all（默认 all，自动跳过不存在的 agent）
.PARAMETER DryRun
  只打印将要做什么。
#>
[CmdletBinding()]
param(
  [ValidateSet('workbuddy','dsh','all')][string]$Agent = 'all',
  [switch]$DryRun,
  [string]$SkillRoot
)
$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:Report = New-Object System.Collections.ArrayList
function Say([string]$m) { Write-Host $m; [void]$script:Report.Add($m) }
function Backup([string]$path) {
  $bak = "$path.bak-$stamp"
  Copy-Item -LiteralPath $path -Destination $bak -Force
  Say ("  [备份] " + (Split-Path -Leaf $bak))
}

if (-not $SkillRoot) { $SkillRoot = $PSScriptRoot }
if (-not (Test-Path (Join-Path $SkillRoot '..\SKILL.md'))) {
  # 允许从项目根或 mcp\ 目录调用
  if (Test-Path (Join-Path $SkillRoot 'SKILL.md')) { $projRoot = $SkillRoot } else { $projRoot = Split-Path $SkillRoot -Parent }
} else { $projRoot = Split-Path $SkillRoot -Parent }

$skillMd = Join-Path $projRoot 'SKILL.md'
$mcpServer = Join-Path $projRoot 'mcp\printer-mcp.mjs'
if (-not (Test-Path $skillMd)) { throw "SKILL.md not found: $skillMd" }
if (-not (Test-Path $mcpServer)) { throw "mcp server not found: $mcpServer" }

Say '=== 注册打印机技能到 AI agent ==='
if ($DryRun) { Say '模式：DryRun（不写文件）' }

# ---------- WorkBuddy ----------
$wb = Join-Path $env:USERPROFILE '.workbuddy'
if (($Agent -eq 'all' -or $Agent -eq 'workbuddy') -and (Test-Path $wb)) {
  Say ''
  Say '[WorkBuddy]'
  $wbSkills = Join-Path $wb 'skills'
  $dstSkill = Join-Path $wbSkills 'printer'
  if (Test-Path (Join-Path $dstSkill 'SKILL.md')) {
    Say '  [跳过] 技能目录已存在 skills\printer\SKILL.md'
  } elseif ($DryRun) {
    Say "  [计划] 复制 SKILL.md -> $dstSkill\SKILL.md"
  } else {
    New-Item -ItemType Directory -Force -Path $dstSkill | Out-Null
    Copy-Item $skillMd (Join-Path $dstSkill 'SKILL.md') -Force
    Say "  [完成] 技能已放入 $dstSkill"
  }

  $wbMcp = Join-Path $wb 'mcp.json'
  if (Test-Path $wbMcp) {
    $cfg = Get-Content $wbMcp -Raw -Encoding utf8 | ConvertFrom-Json
    if (-not $cfg.mcpServers) { $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force }
    if ($cfg.mcpServers.PSObject.Properties.Name -contains 'printer') {
      Say '  [跳过] mcp.json 已有 printer 条目'
    } elseif ($DryRun) {
      Say "  [计划] mcp.json 增加 printer（stdio node printer-mcp.mjs）"
    } else {
      Backup $wbMcp
      $entry = [pscustomobject]@{
        type = 'stdio'
        command = (Get-Command node).Source
        args = @($mcpServer)
        env = [pscustomobject]@{}
      }
      $cfg.mcpServers | Add-Member -NotePropertyName printer -NotePropertyValue $entry -Force
      ($cfg | ConvertTo-Json -Depth 10) | Set-Content -LiteralPath $wbMcp -Encoding utf8
      Say '  [完成] mcp.json 已加入 printer'
    }
  } else { Say "  [跳过] 未找到 $wbMcp" }
}

# ---------- DSH ----------
$dshHome = $env:DSH_HOME
if (-not $dshHome) {
  foreach ($c in @((Join-Path $env:USERPROFILE '.dsh\home'), (Join-Path $env:USERPROFILE '.dsh'))) {
    if (Test-Path (Join-Path $c 'profiles')) { $dshHome = $c; break }
  }
}
if (($Agent -eq 'all' -or $Agent -eq 'dsh') -and $dshHome -and (Test-Path $dshHome)) {
  Say ''
  Say "[DSH] home=$dshHome"
  $dshSkills = Join-Path $dshHome 'skills'
  $dstSkill = Join-Path $dshSkills 'printer'
  if (Test-Path (Join-Path $dstSkill 'SKILL.md')) {
    Say '  [跳过] 技能目录已存在 skills\printer\SKILL.md'
  } elseif ($DryRun) {
    Say "  [计划] 复制 SKILL.md -> $dstSkill\SKILL.md"
  } else {
    New-Item -ItemType Directory -Force -Path $dstSkill | Out-Null
    Copy-Item $skillMd (Join-Path $dstSkill 'SKILL.md') -Force
    Say "  [完成] 技能已放入 $dstSkill"
  }

  $patch = Join-Path $dshHome 'profiles\web\cordis.patch.yml'
  if (Test-Path $patch) {
    $body = Get-Content $patch -Raw -Encoding utf8
    if ($body -match 'printer-mcp') {
      Say '  [跳过] cordis.patch.yml 已有 printer-mcp 注册'
    } elseif ($DryRun) {
      Say '  [计划] cordis.patch.yml 追加 mcp-mobile 风格的 printer 客户端'
    } else {
      Backup $patch
      $block = @(
        ''
        '# printer MCP（本地技能）'
        '- insert:'
        '    - id: mcp-printer'
        "      name: '@deepseek-ai/dsh-mcp-client'"
        '      config:'
        '        serverName: printer'
        '        transport: stdio'
        "        command: '" + ((Get-Command node).Source).Replace('\','\\') + "'"
        '        args:'
        "          ["
        "            '" + $mcpServer.Replace('\','\\') + "'"
        '          ]'
        '        failOnStartupError: false'
      ) -join [string]([char]13) + [string]([char]10)
      Add-Content -LiteralPath $patch -Value ($block + [string]([char]13) + [string]([char]10)) -Encoding utf8 -NoNewline
      Say '  [完成] cordis.patch.yml 已追加 printer MCP 客户端'
    }
  } else { Say "  [跳过] 未找到 $patch" }
}

Say ''
Say '=== 完成 ==='
if ($DryRun) { Say '这是 DryRun：没有写入任何文件。' }
