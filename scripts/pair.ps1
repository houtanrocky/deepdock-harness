[CmdletBinding()]
param([switch]$RotateToken)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$arguments = @((Join-Path $PSScriptRoot 'bridge.mjs'), 'pair')
if ($RotateToken) { $arguments += '--rotate-token' }
& node @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$config = Get-Content -LiteralPath (Join-Path $repoRoot 'bridge/config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
try {
    Set-Clipboard -Value $config.token -ErrorAction Stop
    Write-Host '[DeepDock Harness] verified token copied to clipboard. Paste it into the extension Settings.'
} catch {
    Write-Host '[DeepDock Harness] clipboard is unavailable. Copy the token from bridge/config.json into the extension Settings.'
}
