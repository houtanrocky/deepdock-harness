[CmdletBinding()]
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$action = if ($Stop) { 'stop' } else { 'start' }
& node (Join-Path $PSScriptRoot 'bridge.mjs') $action
exit $LASTEXITCODE
