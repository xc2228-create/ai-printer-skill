#Requires -Version 5.1
<#
.SYNOPSIS
    把 .docx / .xlsx 用 Office COM 转成 PDF（打印链路 A：保格式）。

.DESCRIPTION
    只做一件事：Office 应用 -> PDF。转换完必须 Close + Quit + 释放 COM 对象，
    否则 WINWORD/EXCEL 会残留、文件被锁。

    - Word：Documents.Open(ReadOnly) -> SaveAs2(wdFormatPDF=17)
    - Excel：Workbooks.Open(ReadOnly) -> 第一个工作表 ExportAsFixedFormat(0=PDF)

    超时由调用方（Node spawnSync，90 秒）负责强制结束；本脚本在开始时把 COM
    进程 PID 打到 stdout（P1_COM_PID:<pid>），调用方超时后据此结束残留进程。

    输出：P1_RESULT:{json} / 失败：stderr P1_ERROR + exit 4
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Word', 'Excel')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][string]$OutputPdf,
    [switch]$FirstSheetOnly,
    [switch]$Landscape
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$app = $null
$doc = $null
$book = $null
$release = New-Object System.Collections.Generic.List[object]
$started = Get-Date

function Write-Marker([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

function Release-Com($object) {
    if ($null -eq $object) { return }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($object) } catch { }
}

function Get-ProcessIdByName([string]$name) {
    $ids = @()
    foreach ($p in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        if ($null -ne $p) { $ids += [int]$p.Id }
    }
    return $ids
}

try {
    $in = [System.IO.Path]::GetFullPath($InputFile)
    $out = [System.IO.Path]::GetFullPath($OutputPdf)
    if (-not (Test-Path -LiteralPath $in)) { throw ('input file not found: ' + $in) }
    $outDir = [System.IO.Path]::GetDirectoryName($out)
    if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
        [void][System.IO.Directory]::CreateDirectory($outDir)
    }
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }

    $procName = if ($Kind -eq 'Word') { 'WINWORD' } else { 'EXCEL' }
    $before = Get-ProcessIdByName $procName

    if ($Kind -eq 'Word') {
        $app = New-Object -ComObject Word.Application
        [void]$release.Add($app)
        $newIds = @(Get-ProcessIdByName $procName | Where-Object { $before -notcontains $_ })
        if ($newIds.Count -gt 0) { Write-Marker ('P1_COM_PID:' + $newIds[0]) }
        $app.Visible = $false
        $app.DisplayAlerts = 0
        try { $app.AutomationSecurity = 3 } catch { }
        try { $app.Options.UpdateLinksAtOpen = $false } catch { }
        $doc = $app.Documents.Open($in, $false, $true)
        [void]$release.Add($doc)
        try {
            $doc.SaveAs2($out, 17)
        } catch {
            # SaveAs2 不存在时退回 SaveAs([ref] 参数)
            $ref = [System.Reflection.Missing]::Value
            $doc.SaveAs([ref]$out, [ref]17)
        }
    } else {
        $app = New-Object -ComObject Excel.Application
        [void]$release.Add($app)
        $newIds = @(Get-ProcessIdByName $procName | Where-Object { $before -notcontains $_ })
        if ($newIds.Count -gt 0) { Write-Marker ('P1_COM_PID:' + $newIds[0]) }
        $app.Visible = $false
        $app.DisplayAlerts = $false
        try { $app.AskToUpdateLinks = $false } catch { }
        try { $app.EnableEvents = $false } catch { }
        $book = $app.Workbooks.Open($in, 0, $true)
        [void]$release.Add($book)
        $target = $book
        if ($FirstSheetOnly) { $target = $book.Worksheets.Item(1) }
        # 打印友好的页面设置（只改内存对象，不回写文件）：
        # 打印网格线、按一页宽缩放，避免列被裁掉或横跨两张纸。
        try {
            $target.PageSetup.PrintGridlines = $true
            # 纸张方向必须和最终出纸方向一致，否则导出页是竖版、印到横版纸上就只剩一半宽
            try { $target.PageSetup.Orientation = if ($Landscape) { 2 } else { 1 } } catch { }
            try {
                $target.PageSetup.PaperSize = 9   # xlPaperA4
            } catch { }
            # PRINTER_XLSX_SCALE=actual → 按 100% 原始比例打印（字大，列多时可能分页）
            # 默认 fit → 缩到一页宽（字会变小，但不会被裁列）
            $scaleRaw = ([string]$env:PRINTER_XLSX_SCALE).Trim()
            $scaleNum = 0
            $isNum = [int]::TryParse($scaleRaw, [ref]$scaleNum)
            if ($scaleRaw.ToLower() -eq 'actual' -or ($isNum -and $scaleNum -ge 10 -and $scaleNum -le 400)) {
                $target.PageSetup.FitToPagesWide = 0
                $target.PageSetup.FitToPagesTall = 0
                $target.PageSetup.Zoom = if ($isNum) { [int]$scaleNum } else { 100 }
            } else {
                $target.PageSetup.Zoom = $false
                $target.PageSetup.FitToPagesWide = 1
                $target.PageSetup.FitToPagesTall = $false
            }
        } catch { }
        $target.ExportAsFixedFormat(0, $out)
    }

    $exists = $false
    for ($i = 0; $i -lt 100; $i++) {
        if ((Test-Path -LiteralPath $out) -and ((Get-Item -LiteralPath $out).Length -gt 0)) {
            $exists = $true
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $exists) { throw ('Office did not produce a PDF: ' + $out) }

    $bytes = (Get-Item -LiteralPath $out).Length
    $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
    $result = [pscustomobject]@{
        kind = $Kind
        path = 'com'
        pdf = $out
        bytes = $bytes
        ms = $elapsed
    }
    Write-Marker ('P1_RESULT:' + ($result | ConvertTo-Json -Compress))
} catch {
    $message = $_.Exception.Message -replace '[^\x20-\x7E]', '?'
    [Console]::Error.WriteLine('P1_ERROR stage=office-com ' + $message)
    exit 4
} finally {
    if ($null -ne $doc) { try { $doc.Close(0) } catch { } }
    if ($null -ne $book) { try { $book.Close($false) } catch { } }
    if ($null -ne $app) { try { $app.Quit() } catch { } }
    for ($i = $release.Count - 1; $i -ge 0; $i--) { Release-Com $release[$i] }
    $doc = $null
    $book = $null
    $app = $null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
