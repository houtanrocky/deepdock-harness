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

$startupPath = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupPath 'DeepDock Bridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $InstallDir 'launch.vbs') + '"'
$shortcut.WorkingDirectory = $InstallDir
$shortcut.WindowStyle = 7
$shortcut.Save()

$null = Set-Clipboard -Value $token
$launch = Join-Path $env:WINDIR 'System32\wscript.exe'
Start-Process -FilePath $launch -ArgumentList ('"' + (Join-Path $InstallDir 'launch.vbs') + '"') -WindowStyle Hidden
Add-Type -AssemblyName System.Windows.Forms
[void][Windows.Forms.MessageBox]::Show(
    "DeepDock Bridge is installed and will start when you sign in.`r`n`r`nYour pairing token has been copied to the clipboard. Paste it into DeepDock extension settings.`r`n`r`nProject folder: $($config.allowedRoots[0])`r`nBridge address: http://127.0.0.1:$($config.port)",
    'DeepDock Bridge is ready',
    [Windows.Forms.MessageBoxButtons]::OK,
    [Windows.Forms.MessageBoxIcon]::Information
)
