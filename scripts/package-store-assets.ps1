[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($packageVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a numeric package release version.' }
$kitDir = Join-Path $repoRoot 'chrome-web-store-submission'
$outputDir = Join-Path $repoRoot 'dist\store-assets'
$stageDir = Join-Path $outputDir $packageVersion
$zipPath = Join-Path $outputDir "deepdock-harness-store-assets-$packageVersion.zip"
New-Item -ItemType Directory -Path $stageDir,(Join-Path $stageDir 'extension'),(Join-Path $stageDir 'branding') -Force | Out-Null

$textFiles = @('UPLOAD-GUIDE.md','PRIVACY-ANSWERS.md','description.txt','listing-fields.json','privacy-fields.json','store-listing.md','permissions.md','data-use-disclosure.md','privacy-policy.md','asset-preview.html','asset-report.json')
foreach ($file in $textFiles) { Copy-Item -LiteralPath (Join-Path $kitDir $file) -Destination $stageDir -Force }
Copy-Item -LiteralPath (Join-Path $kitDir 'screenshots') -Destination $stageDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $kitDir 'promotional') -Destination $stageDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $kitDir 'extension\store-icon-128.png') -Destination (Join-Path $stageDir 'extension\store-icon-128.png') -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'extension\src\assets\logo.svg') -Destination (Join-Path $stageDir 'branding\logo.svg') -Force

Add-Type -AssemblyName System.IO.Compression
$zipStream = [IO.File]::Open($zipPath, [IO.FileMode]::Create)
$archive = [IO.Compression.ZipArchive]::new($zipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $stageDir -Recurse -File | Sort-Object FullName | ForEach-Object {
        $entryName = $_.FullName.Substring($stageDir.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
        $sourceStream = [IO.File]::OpenRead($_.FullName)
        $entryStream = $entry.Open()
        try { $sourceStream.CopyTo($entryStream) }
        finally { $entryStream.Dispose(); $sourceStream.Dispose() }
    }
}
finally { $archive.Dispose(); $zipStream.Dispose() }
Write-Output "Store artwork bundle created: $zipPath"
