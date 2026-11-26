[CmdletBinding()]
param(
    [string]$InputFile = '',
    [string]$InputFileList = '',
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [Parameter(Mandatory=$true)][string]$Paper,
    [int]$Copies = 1,
    [switch]$Landscape,
    [string]$OutputPdf = "",
    [double]$MarginMm = 25
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$images = $null
$pd = $null
$script:printStarted = $false
$script:pageError = $null

function Write-Result([int]$Pages, [int]$ImageWidth, [int]$ImageHeight, [double]$Scale) {
    $obj = [pscustomobject]@{
        pages = $Pages
        imageWidth = $ImageWidth
        imageHeight = $ImageHeight
        scale = [Math]::Round($Scale, 4)
        printer = $PrinterName
    }
    Write-Output ("P1_RESULT:" + ($obj | ConvertTo-Json -Compress))
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

try {
    Add-Type -AssemblyName System.Drawing

    $paths = New-Object 'System.Collections.Generic.List[string]'
    if ($InputFileList -ne '') {
        $listLines = [System.IO.File]::ReadAllLines($InputFileList, [System.Text.Encoding]::UTF8)
        foreach ($listLine in $listLines) {
            $trimmed = $listLine.Trim()
            if ($trimmed.Length -gt 0) { [void]$paths.Add($trimmed) }
        }
    } elseif ($InputFile -ne '') {
        [void]$paths.Add($InputFile)
    }
    if ($paths.Count -eq 0) { throw 'no image input' }

    $images = New-Object 'System.Collections.Generic.List[object]'
    foreach ($file in $paths) {
        $img = [System.Drawing.Image]::FromFile($file)
        if ($null -eq $img -or $img.Width -le 0 -or $img.Height -le 0) { throw "cannot read image: $file" }
        [void]$images.Add($img)
    }
    if ($images.Count -eq 0) { throw 'no image loaded' }
    if ($OutputPdf -eq '' -and $PrinterName -match 'Print to PDF') {
        throw 'OutputPdf is required for Microsoft Print to PDF'
    }

    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.DocumentName = [System.IO.Path]::GetFileName($paths[0])
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

    $script:images = $images
    $script:index = 0
    $script:marginPt = $marginPt
    $script:contentWidth = $contentWidth
    $script:contentHeight = $contentHeight

    $pd.add_PrintPage({
        param($sender, $eventArgs)
        try {
            $g = $eventArgs.Graphics
            $g.PageUnit = [System.Drawing.GraphicsUnit]::Point
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $img = $script:images[$script:index]
            $fitX = [double]$script:contentWidth / [double]$img.Width
            $fitY = [double]$script:contentHeight / [double]$img.Height
            $scale = [Math]::Min($fitX, $fitY)
            # Never enlarge past 96 dpi 1:1 (0.75 pt per pixel): upscaling a small
            # image to full page is what made prints look blurry.
            if ($scale -gt 0.75) { $scale = 0.75 }
            if ($scale -le 0) { throw 'invalid image scale' }
            $drawWidth = [single]($img.Width * $scale)
            $drawHeight = [single]($img.Height * $scale)
            $drawX = [single]($script:marginPt + (($script:contentWidth - $drawWidth) / 2.0))
            $drawY = [single]($script:marginPt + (($script:contentHeight - $drawHeight) / 2.0))
            $g.DrawImage($img, [single]$drawX, [single]$drawY, [single]$drawWidth, [single]$drawHeight)
            $script:index = $script:index + 1
            if ($script:index -lt $script:images.Count) {
                $eventArgs.HasMorePages = $true
            } else {
                $eventArgs.HasMorePages = $false
            }
        } catch {
            $script:pageError = $_.Exception.Message
            throw
        }
    })

    $first = $images[0]
    $firstScale = [Math]::Min(
        [Math]::Min([double]$contentWidth / [double]$first.Width, [double]$contentHeight / [double]$first.Height),
        0.75
    )

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

    Write-Result $images.Count $first.Width $first.Height $firstScale
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
    if ($null -ne $images) {
        foreach ($img in $images) {
            if ($null -ne $img) { $img.Dispose() }
        }
    }
    if ($null -ne $pd) { $pd.Dispose() }
}
