[CmdletBinding()]
param(
    [string]$NodeVersion = '22.18.0',
    [string]$InnoCompiler = 'ISCC.exe'
)
$ErrorActionPreference = 'Stop'
$installerDir = $PSScriptRoot
$repoRoot = Split-Path -Parent (Split-Path -Parent $installerDir)
$buildDir = Join-Path $installerDir 'build'
$bridgeBuild = Join-Path $buildDir 'bridge'
$resolvedBuildDir = [IO.Path]::GetFullPath($buildDir)
$resolvedBridgeBuild = [IO.Path]::GetFullPath($bridgeBuild)
if (-not $resolvedBridgeBuild.StartsWith($resolvedBuildDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Bridge staging directory must stay inside $resolvedBuildDir"
}
$nodeZip = Join-Path $buildDir "node-v$NodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

if (-not (Test-Path -LiteralPath $nodeZip)) {
    New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
    Write-Host "Downloading Node.js $NodeVersion runtime from nodejs.org..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
}
$checksums = Invoke-RestMethod -Uri "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$checksumLine = $checksums -split "`n" | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?node-v$([regex]::Escape($NodeVersion))-win-x64\.zip\s*$" } | Select-Object -First 1
if (-not $checksumLine) { throw "Could not find the official checksum for $nodeZip" }
$expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw "Node.js archive checksum mismatch: $nodeZip" }

$extractDir = Join-Path $buildDir "node-v$NodeVersion-win-x64"
if (-not (Test-Path -LiteralPath (Join-Path $extractDir 'node.exe'))) {
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $buildDir -Force
}
Copy-Item -LiteralPath (Join-Path $extractDir 'node.exe') -Destination (Join-Path $buildDir 'node.exe') -Force

if (Test-Path -LiteralPath $bridgeBuild) { Remove-Item -LiteralPath $bridgeBuild -Recurse -Force }
New-Item -ItemType Directory -Path $bridgeBuild -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'bridge') -Filter '*.js' -File |
    Copy-Item -Destination $bridgeBuild -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'bridge\tool-modules') -Destination $bridgeBuild -Recurse -Force
Copy-Item -LiteralPath (Join-Path $installerDir 'bridge-host.js') -Destination $buildDir -Force
Copy-Item -LiteralPath (Join-Path $installerDir 'launch.vbs') -Destination $buildDir -Force
Copy-Item -LiteralPath (Join-Path $installerDir 'stop.vbs') -Destination $buildDir -Force
Copy-Item -LiteralPath (Join-Path $installerDir 'setup.ps1') -Destination $buildDir -Force

$compiler = Get-Command $InnoCompiler -ErrorAction SilentlyContinue
if (-not $compiler) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $candidate = $candidates | Select-Object -First 1
    if ($candidate) { $InnoCompiler = [string]$candidate }
    else { throw 'Inno Setup 6 is required to compile the installer. Install it from https://jrsoftware.org/isinfo.php, then rerun this script.' }
} else { $InnoCompiler = [string]$compiler.Source }

Push-Location $installerDir
try {
    $compilerPath = (Resolve-Path -LiteralPath $InnoCompiler).Path
    $compile = Start-Process -FilePath $compilerPath -ArgumentList 'deepdock.iss' -Wait -PassThru -NoNewWindow
    if ($compile.ExitCode -ne 0) { throw "Inno Setup compiler exited with code $($compile.ExitCode)" }
}
finally { Pop-Location }
Write-Host "Installer created under $repoRoot\dist\installer"
