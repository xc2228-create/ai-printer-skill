[CmdletBinding()]
param(
    [string]$InputFile = 'text.txt',
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [Parameter(Mandatory=$true)][string]$Paper,
    [int]$Copies = 1,
    [switch]$Landscape,
    [string]$OutputPdf = "",
    [double]$FontSize = 10.5,
    [double]$MarginMm = 20,
    [double]$LineSpacing = 1.5,
    [string]$FontFamily = '微软雅黑',
    # >0 时自动缩小字号，直到总页数 <= 该值（解决「打在一张纸上」要反复试字号的问题）
    [int]$FitPages = 0
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$fonts = @{}
$defaultFont = $null
$footerFont = $null
$pd = $null
$bmp = $null
$measureGraphics = $null
$script:printStarted = $false
$script:pageError = $null

function Write-Result([int]$Pages, [int]$Lines, [bool]$FontOk, [double]$UsedFontSize = 0) {
    $obj = [pscustomobject]@{
        pages = $Pages
        lines = $Lines
        fontOk = $FontOk
        printer = $PrinterName
        fontSizeUsed = $UsedFontSize
        fitPages = $FitPages
    }
    Write-Output ("P1_RESULT:" + ($obj | ConvertTo-Json -Compress))
}

function Read-StdinText {
    $stdin = [Console]::OpenStandardInput()
    $ms = New-Object System.IO.MemoryStream
    $stdin.CopyTo($ms)
    $bytes = $ms.ToArray()
    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Get-PaperKind([string]$name) {
    switch ($name) {
        'A4' { return [System.Drawing.Printing.PaperKind]::A4 }
        'A5' { return [System.Drawing.Printing.PaperKind]::A5 }
        'Letter' { return [System.Drawing.Printing.PaperKind]::Letter }
        default { throw "unsupported paper: $name" }
    }
}

function Get-PaperSize($settings, [string]$name, [System.Drawing.Printing.PaperKind]$kind) {
    foreach ($size in $settings.PaperSizes) {
        if ($size.Kind -eq $kind) { return $size }
    }
    switch ($name) {
        'A4' { return (New-Object System.Drawing.Printing.PaperSize('A4', 827, 1169)) }
        'A5' { return (New-Object System.Drawing.Printing.PaperSize('A5', 583, 827)) }
        'Letter' { return (New-Object System.Drawing.Printing.PaperSize('Letter', 850, 1100)) }
    }
    throw "no paper size for $name"
}

function Get-Font([double]$size, [bool]$bold) {
    $key = ('{0:0.###}|{1}' -f $size, $bold)
    if (-not $script:fonts.ContainsKey($key)) {
        $style = [System.Drawing.FontStyle]::Regular
        if ($bold) { $style = [System.Drawing.FontStyle]::Bold }
        $script:fonts[$key] = New-Object System.Drawing.Font($FontFamily, [single]$size, $style, [System.Drawing.GraphicsUnit]::Point)
    }
    return $script:fonts[$key]
}

function Get-WrappedLines([string]$text, $graphics, $font, [single]$maxWidth) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $normalized = $text.Replace([string][char]13, '')
    $paragraphs = $normalized.Split([char]10)
    foreach ($paragraph in $paragraphs) {
        $remaining = $paragraph.TrimEnd()
        if ($remaining.Length -eq 0) {
            [void]$lines.Add('')
            continue
        }
        while ($remaining.Length -gt 0) {
            if ($graphics.MeasureString($remaining, $font).Width -le $maxWidth) {
                [void]$lines.Add($remaining)
                break
            }
            $low = 1
            $high = $remaining.Length
            $best = 1
            while ($low -le $high) {
                $mid = [int][Math]::Floor(($low + $high) / 2)
                $candidate = $remaining.Substring(0, $mid)
                if ($graphics.MeasureString($candidate, $font).Width -le $maxWidth) {
                    $best = $mid
                    $low = $mid + 1
                } else {
                    $high = $mid - 1
                }
            }
            $cut = $best
            $prefix = $remaining.Substring(0, $best)
            $spaceAt = $prefix.LastIndexOf(' ')
            if ($spaceAt -gt [int][Math]::Floor($best * 0.55)) {
                $cut = $spaceAt
            }
            if ($cut -lt 1) { $cut = 1 }
            $line = $remaining.Substring(0, $cut).TrimEnd()
            if ($line.Length -eq 0) {
                $line = $remaining.Substring(0, $cut)
            }
            [void]$lines.Add($line)
            $remaining = $remaining.Substring($cut).TrimStart()
        }
    }
    return ,$lines
}

try {
    Add-Type -AssemblyName System.Drawing
    $text = Read-StdinText
    if ($text.Length -eq 0) { throw 'stdin text is empty' }
    $displayName = [System.IO.Path]::GetFileName($InputFile)

    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.DocumentName = $displayName
    $pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
    $pd.PrinterSettings.PrinterName = $PrinterName
    if (-not $pd.PrinterSettings.IsValid) { throw "printer is not valid: $PrinterName" }
    $pd.PrinterSettings.Copies = [int16]$Copies

    $paperKind = Get-PaperKind $Paper
    $paperSize = Get-PaperSize $pd.PrinterSettings $Paper $paperKind
    $pd.DefaultPageSettings.PaperSize = $paperSize
    $pd.DefaultPageSettings.Landscape = [bool]$Landscape
    if ($MarginMm -lt 0) { $MarginMm = 0 }
    $marginHundredths = [int][Math]::Round(($MarginMm / 25.4) * 100.0)
    $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins($marginHundredths, $marginHundredths, $marginHundredths, $marginHundredths)
    $pd.OriginAtMargins = $false

    if ($OutputPdf -ne '') {
        $pd.PrinterSettings.PrintToFile = $true
        $pd.PrinterSettings.PrintFileName = $OutputPdf
    }

    $defaultFont = Get-Font $FontSize $false
    $footerFont = New-Object System.Drawing.Font('微软雅黑', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)

    $pageWidthPt = [single](($paperSize.Width / 100.0) * 72.0)
    $pageHeightPt = [single](($paperSize.Height / 100.0) * 72.0)
    if ($Landscape) {
        $tmp = $pageWidthPt
        $pageWidthPt = $pageHeightPt
        $pageHeightPt = $tmp
    }
    $marginPt = [single](($MarginMm / 25.4) * 72.0)
    $contentWidth = [single]($pageWidthPt - (2.0 * $marginPt))
    $contentHeight = [single]($pageHeightPt - (2.0 * $marginPt))
    if ($contentWidth -le 20 -or $contentHeight -le 20) { throw 'printable area is too small' }

    $bmp = New-Object System.Drawing.Bitmap 8, 8
    $measureGraphics = [System.Drawing.Graphics]::FromImage($bmp)
    $measureGraphics.PageUnit = [System.Drawing.GraphicsUnit]::Point

    $text2 = $text.Replace([string][char]13, '')
    $sourceLines = $text2.Split([char]10)

    # 候选字号：未开启自动适配时只有原始字号；开启时从原字号往下每 0.5pt 试一次
    $baseSize = $FontSize
    $candidateSizes = New-Object 'System.Collections.Generic.List[double]'
    if ($FitPages -gt 0) {
        $try = $baseSize
        while ($try -ge 5.5) {
            [void]$candidateSizes.Add([Math]::Round($try, 1))
            $try = $try - 0.5
        }
    } else {
        [void]$candidateSizes.Add($baseSize)
    }

    $layout = $null
    $pages = $null
    $usedSize = $baseSize

    $spacingList = @($LineSpacing)
    if ($FitPages -gt 0) { $spacingList = @(1.5, 1.25, 1.05) }
    $usedSpacing = $LineSpacing

    foreach ($candSize in $candidateSizes) {
    foreach ($candSpacing in $spacingList) {
    $scale = [double]($candSize / $baseSize)
    $parsed = New-Object 'System.Collections.Generic.List[object]'
    foreach ($line in $sourceLines) {
        $size = $candSize
        $bold = $false
        $pageBreak = $false
        $body = $line
        # 控制前缀可连续出现：PB 换页、12.5b 字号/加粗
        while ($body.Length -gt 1 -and $body[0] -eq [char]1) {
            $end = $body.IndexOf([char]2)
            if ($end -le 1) { break }
            $token = $body.Substring(1, $end - 1)
            $body = $body.Substring($end + 1)
            if ($token -eq 'PB') {
                $pageBreak = $true
                continue
            }
            if ($token.EndsWith('b')) {
                $bold = $true
                $token = $token.Substring(0, $token.Length - 1)
            }
            $parsedSize = 0.0
            if ([double]::TryParse($token, [ref]$parsedSize)) {
                if ($parsedSize -ge 4 -and $parsedSize -le 72) { $size = [Math]::Round($parsedSize * $scale, 2) }
            }
        }
        [void]$parsed.Add([pscustomobject]@{ text = $body; size = $size; bold = $bold; pageBreak = $pageBreak })
    }

    $layout = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in $parsed) {
        $font = Get-Font $item.size $item.bold
        $lineH = [single]($item.size * $candSpacing)
        if ($item.text.Length -eq 0) {
            [void]$layout.Add([pscustomobject]@{ text = ''; font = $font; height = $lineH; pageBreak = $item.pageBreak })
            continue
        }
        $pieces = Get-WrappedLines $item.text $measureGraphics $font ([single]($contentWidth * 0.99))
        $firstPiece = $true
        foreach ($piece in $pieces) {
            $pieceBreak = ($item.pageBreak -and $firstPiece)
            [void]$layout.Add([pscustomobject]@{ text = $piece; font = $font; height = $lineH; pageBreak = $pieceBreak })
            $firstPiece = $false
        }
    }

    $footerHeight = [single]($footerFont.GetHeight($measureGraphics) * 1.2)
    $maxY = [single]($contentHeight - $footerHeight)
    if ($maxY -lt 20) { $maxY = $contentHeight }
    $pages = New-Object 'System.Collections.Generic.List[object]'
    $current = New-Object 'System.Collections.Generic.List[object]'
    $y = [single]0
    foreach ($item in $layout) {
        if ($item.pageBreak -and $current.Count -gt 0) {
            [void]$pages.Add($current)
            $current = New-Object 'System.Collections.Generic.List[object]'
            $y = [single]0
        }
        if (($y + $item.height) -gt $maxY -and $current.Count -gt 0) {
            [void]$pages.Add($current)
            $current = New-Object 'System.Collections.Generic.List[object]'
            $y = [single]0
        }
        [void]$current.Add([pscustomobject]@{ text = $item.text; font = $item.font; y = $y })
        $y = [single]($y + $item.height)
    }
    [void]$pages.Add($current)
    $usedSize = $candSize
    $usedSpacing = $candSpacing
    if ($FitPages -le 0 -or $pages.Count -le $FitPages) { break }
    }
    if ($FitPages -le 0 -or ($pages -and $pages.Count -le $FitPages)) { break }
    }

    $totalPages = [int][Math]::Max(1, $pages.Count)

    $script:pageItems = $pages
    $script:totalPages = $totalPages
    $script:renderedPages = 0
    $script:lineCount = $layout.Count
    $script:marginPt = $marginPt
    $script:contentWidth = $contentWidth
    $script:pageHeightPt = $pageHeightPt
    $script:footerFont = $footerFont
    $script:displayName = $displayName

    $pd.add_PrintPage({
        param($sender, $eventArgs)
        try {
            $g = $eventArgs.Graphics
            $g.PageUnit = [System.Drawing.GraphicsUnit]::Point
            $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            $items = $script:pageItems[$script:renderedPages]
            foreach ($item in $items) {
                if ($item.text.Length -gt 0) {
                    $g.DrawString($item.text, $item.font, [System.Drawing.Brushes]::Black, [single]$script:marginPt, [single]($script:marginPt + $item.y))
                }
            }
            $pageNo = $script:renderedPages + 1
            $footer = $script:displayName + ' · 第 ' + $pageNo + '/' + $script:totalPages + ' 页'
            while ($footer.Length -gt 8 -and $g.MeasureString($footer, $script:footerFont).Width -gt $script:contentWidth) {
                $footer = $footer.Substring(1)
            }
            $footerWidth = $g.MeasureString($footer, $script:footerFont).Width
            $footerX = [single]($script:marginPt + $script:contentWidth - $footerWidth)
            $footerY = [single]($script:pageHeightPt - $script:marginPt - $script:footerFont.GetHeight($g))
            $g.DrawString($footer, $script:footerFont, [System.Drawing.Brushes]::Gray, $footerX, $footerY)
            $script:renderedPages = $script:renderedPages + 1
            if ($script:renderedPages -lt $script:totalPages) {
                $eventArgs.HasMorePages = $true
            } else {
                $eventArgs.HasMorePages = $false
            }
        } catch {
            $script:pageError = $_.Exception.Message
            throw
        }
    })

    $script:printStarted = $true
    $pd.Print()

    if ($OutputPdf -ne '') {
        $exists = $false
        for ($i = 0; $i -lt 100; $i++) {
            if ((Test-Path -LiteralPath $OutputPdf) -and ((Get-Item -LiteralPath $OutputPdf).Length -gt 0)) {
                $exists = $true
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $exists) { throw "PDF was not created: $OutputPdf" }
    }

    Write-Result $totalPages $script:lineCount ($defaultFont.Name.Length -gt 0) $usedSize
} catch {
    $message = $_.Exception.Message -replace '[^\x20-\x7E]', '?'
    if ($script:pageError -ne $null) {
        [Console]::Error.WriteLine('P1_ERROR stage=render ' + $message)
        exit 4
    }
    if ($script:printStarted) {
        [Console]::Error.WriteLine('P1_ERROR stage=print ' + $message)
        exit 5
    }
    [Console]::Error.WriteLine('P1_ERROR stage=render ' + $message)
    exit 4
} finally {
    if ($null -ne $measureGraphics) { $measureGraphics.Dispose() }
    if ($null -ne $bmp) { $bmp.Dispose() }
    foreach ($f in $fonts.Values) { if ($null -ne $f) { $f.Dispose() } }
    if ($null -ne $footerFont) { $footerFont.Dispose() }
    if ($null -ne $pd) { $pd.Dispose() }
}
