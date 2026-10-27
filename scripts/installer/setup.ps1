param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$workspacePath = [IO.Path]::GetFullPath($Workspace)
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
    throw "The selected project folder does not exist: $workspacePath"
}

$configDir = Join-Path $env:APPDATA 'DeepDock'
$configPath = Join-Path $configDir 'config.json'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $configPath)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    $config = [ordered]@{
        port = 8765
        token = $token
        allowedRoots = @($workspacePath)
        bashTimeoutMs = 20000
        bashTimeoutMaxMs = 120000
        handoffTimeoutMs = 300000
        handoffTimeoutMaxMs = 1800000
        dailySendLimit = 200
    }
    $json = $config | ConvertTo-Json -Depth 5
    [IO.File]::WriteAllText($configPath, $json + "`n", [Text.UTF8Encoding]::new($false))
} else {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $token = [string]$config.token
    $config.allowedRoots = @($workspacePath)
    $json = $config | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($configPath, $json + "`n", [Text.UTF8Encoding]::new($false))
}

# Remove the shortcut created unconditionally by the original installer.
$startupPath = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupPath 'DeepDock Harness Bridge.lnk'
if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
# Setup configures pairing only. The user starts the bridge from the desktop app.
