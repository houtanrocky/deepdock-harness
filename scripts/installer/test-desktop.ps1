[CmdletBinding()]
param([string]$AppDir = '')
$ErrorActionPreference = 'Stop'
if (-not $AppDir) { $AppDir = Join-Path $PSScriptRoot 'build' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DeepDockCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
}
'@
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('deepdock-desktop-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $fixture 'profile'
$configDir = Join-Path $profile 'DeepDock'
$app = Join-Path $fixture 'app'
$evidence = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'dist\installer\evidence'
$process = $null
$sentinel = $null
$extraProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$oldClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue

function Wait-For([scriptblock]$Condition, [string]$Message) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Message
}
function Find-Element([string]$Name) {
  $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name)
  return $script:window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Click-Button([string]$Name) {
  $button = Find-Element $Name
  if (-not $button) { throw "Missing control: $Name" }
  Wait-For { $button.Current.IsEnabled } "Control did not become enabled: $Name"
  $pattern = $null
  if ($button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
  } else {
    if ($button.Current.ClassName -notlike 'WindowsForms10.BUTTON.*') { throw "Not a native button: $Name" }
    [void][DeepDockCapture]::SendMessage([IntPtr]$button.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
function Select-Tab([string]$Name) {
  $condition = [Windows.Automation.AndCondition]::new(
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Name),
    [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  )
  $tab = $script:window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
  if ($tab) {
    $tab.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
  } else {
    $tabs = $script:window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ClassName -like 'WindowsForms10.SysTabControl32.*' } | Select-Object -First 1
    if (-not $tabs) { throw "Missing tab control: $Name" }
    $index = if ($Name -eq 'Bridge') { 0 } else { 1 }
    [void][DeepDockCapture]::SendMessage([IntPtr]$tabs.Current.NativeWindowHandle, 0x1330, [IntPtr]$index, [IntPtr]::Zero)
  }
}
function Capture-Window([string]$Name) {
  $rect = $script:window.Current.BoundingRectangle
  $bitmap = [Drawing.Bitmap]::new([int]$rect.Width, [int]$rect.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  try {
    [void][DeepDockCapture]::PrintWindow($process.MainWindowHandle, $hdc, 2)
  } finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
  try { $bitmap.Save((Join-Path $evidence $Name)) } finally { $bitmap.Dispose() }
}
function Confirm-ForceStop([string]$ExpectedPath) {
  $forceButton = Find-Element 'Force stop bridge...'
  Wait-For { $forceButton.Current.IsEnabled } 'Force stop control did not become enabled.'
  [void][DeepDockCapture]::PostMessage([IntPtr]$forceButton.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  Wait-For {
    $errorCondition = [Windows.Automation.AndCondition]::new(
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'DeepDock Harness Bridge'),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
    )
    $errorDialog = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $errorCondition)
    if ($errorDialog) {
      $messages = $errorDialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name }
      throw ('Force stop failed before confirmation: ' + ($messages -join ' '))
    }
    $dialogCondition = [Windows.Automation.AndCondition]::new(
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Force stop bridge'),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
    )
    $script:dialog = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $dialogCondition)
    $null -ne $script:dialog
  } 'Force stop must ask for confirmation.'
  $contents = $script:dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  if (-not (($contents | ForEach-Object { $_.Current.Name }) -join "`n").Contains($ExpectedPath)) { throw 'Force stop confirmation must identify the actual bridge path.' }
  $yesCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Yes')
  $yes = $script:dialog.FindFirst([Windows.Automation.TreeScope]::Descendants, $yesCondition)
  if (-not $yes) { throw 'Force stop confirmation is missing Yes.' }
  [void][DeepDockCapture]::PostMessage([IntPtr]$yes.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
}

try {
  New-Item -ItemType Directory -Path $app, $configDir, $evidence -Force | Out-Null
  foreach ($name in @('DeepDock.exe', 'node.exe', 'bridge-host.cjs', 'bridge', 'scripts')) {
    Copy-Item -LiteralPath (Join-Path $AppDir $name) -Destination $app -Recurse -Force
  }
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
  $token = 'desktop-test-token'.PadRight(64, '0')
  @{ token = $token; port = $port; allowedRoots = @($fixture) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $configDir 'config.json') -Encoding UTF8
  $info = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'DeepDock.exe'))
  $info.UseShellExecute = $false
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $info.EnvironmentVariables['APPDATA'] = $profile
  $process = [Diagnostics.Process]::Start($info)
  Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Desktop window did not open.'
  $script:window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Opening the desktop app must leave the bridge stopped.'
  Capture-Window 'desktop-stopped.png'
  Click-Button 'Start bridge'
  Wait-For { $null -ne (Find-Element 'Bridge running') } 'Start bridge did not start the bridge.'
  Click-Button 'Copy token'
  Wait-For { (Get-Clipboard -Raw) -eq $token } 'Copy token did not copy the configured token.'
  Capture-Window 'desktop-running.png'
  Click-Button 'Stop bridge'
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Stop bridge did not stop the bridge.'
  Select-Tab 'Help & setup'
  Capture-Window 'desktop-help.png'
  # Close hides the window while the process remains available in the tray.
  [void][DeepDockCapture]::SendMessage($process.MainWindowHandle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  if ($process.HasExited) { throw 'Closing the window must keep the tray app alive.' }
  $second = [Diagnostics.Process]::Start($info)
  if (-not $second.WaitForExit(5000) -or $second.ExitCode -ne 0) { throw 'Second launch did not return to the existing app.' }
  $second.Dispose()
  Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Second launch did not restore the tray window.'
  $script:window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  Select-Tab 'Bridge'
  Click-Button 'Start bridge'
  Wait-For { $null -ne (Find-Element 'Bridge running') } 'Bridge did not restart.'
  # Force recovery must leave an unrelated command using the same runtime alive.
  $sentinelInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'node.exe'), '-e "setInterval(() => {}, 1000)" "' + (Join-Path $app 'bridge\server.js') + '"')
  $sentinelInfo.UseShellExecute = $false; $sentinelInfo.CreateNoWindow = $true
  $sentinel = [Diagnostics.Process]::Start($sentinelInfo)
  Confirm-ForceStop (Join-Path $app 'bridge\server.js')
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Force stop did not terminate the installed bridge.'
  if ($sentinel.HasExited) { throw 'Force stop must not terminate unrelated commands using the bundled runtime.' }

  # Reproduce the reported upgrade: a different runtime and install folder,
  # an old token, and a live bridge occupying the desktop app's configured port.
  $legacyRoot = Join-Path $fixture 'older installation'
  New-Item -ItemType Directory -Path $legacyRoot -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $app 'bridge') -Destination $legacyRoot -Recurse
  $legacyServer = Join-Path $legacyRoot 'bridge\server.js'
  $externalNode = (Get-Command node.exe).Source
  $offPortListener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $offPortListener.Start(); $offPort = $offPortListener.LocalEndpoint.Port; $offPortListener.Stop()
  $legacyBridge = $null; $offPortBridge = $null
  foreach ($entry in @(@{ Port = $port; Name = 'legacy' }, @{ Port = $offPort; Name = 'other-project' })) {
    $legacyConfig = Join-Path $legacyRoot $entry.Name
    New-Item -ItemType Directory -Path $legacyConfig -Force | Out-Null
    @{ token = 'older-install-token'.PadRight(64, '0'); port = $entry.Port; allowedRoots = @($fixture) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $legacyConfig 'config.json') -Encoding UTF8
    $legacyInfo = [Diagnostics.ProcessStartInfo]::new($externalNode, '"' + $legacyServer + '"')
    $legacyInfo.UseShellExecute = $false; $legacyInfo.CreateNoWindow = $true
    $legacyInfo.EnvironmentVariables['DEEPDOCK_CONFIG_DIR'] = $legacyConfig
    $legacyInfo.RedirectStandardOutput = $true; $legacyInfo.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($legacyInfo)
    $null = $child.StandardOutput.ReadToEndAsync(); $null = $child.StandardError.ReadToEndAsync()
    $extraProcesses.Add($child)
    if ($entry.Name -eq 'legacy') { $legacyBridge = $child } else { $offPortBridge = $child }
  }
  Wait-For { $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $legacyBridge.Id) } 'The older bridge did not bind the configured port.'
  Wait-For { $null -ne (Find-Element 'Bridge needs attention') } 'A mismatched legacy token must be reported.'
  Confirm-ForceStop $legacyServer
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Force stop did not recover the bridge from the older runtime and folder.'
  if (-not $legacyBridge.WaitForExit(5000)) { throw 'The verified older bridge survived force stop.' }
  if ($offPortBridge.HasExited) { throw 'Force stop must leave DeepDock bridges on other ports running.' }
  if ($sentinel.HasExited) { throw 'Legacy recovery must leave unrelated Node commands running.' }

  # A generic server.js on the same port must not become a recovery target.
  $unrelatedRoot = Join-Path $fixture 'unrelated\bridge'
  New-Item -ItemType Directory -Path $unrelatedRoot -Force | Out-Null
  $unrelatedScript = Join-Path $unrelatedRoot 'server.js'
  "require('node:http').createServer((req,res) => res.end('unrelated service')).listen($port, '127.0.0.1');" | Set-Content -LiteralPath $unrelatedScript -Encoding UTF8
  $unrelatedInfo = [Diagnostics.ProcessStartInfo]::new($externalNode, '"' + $unrelatedScript + '"')
  $unrelatedInfo.UseShellExecute = $false; $unrelatedInfo.CreateNoWindow = $true
  $unrelated = [Diagnostics.Process]::Start($unrelatedInfo)
  $extraProcesses.Add($unrelated)
  Wait-For { $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $unrelated.Id) } 'Unrelated service did not bind the port.'
  Wait-For { $null -ne (Find-Element 'Bridge needs attention') } 'An unrelated service must be reported.'
  $forceButton = Find-Element 'Force stop bridge...'
  Wait-For { $forceButton.Current.IsEnabled } 'Force stop did not become enabled.'
  [void][DeepDockCapture]::PostMessage([IntPtr]$forceButton.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  Wait-For {
    $warningCondition = [Windows.Automation.AndCondition]::new(
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ClassNameProperty, '#32770'),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'DeepDock Harness Bridge'),
      [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id)
    )
    $script:warning = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Descendants, $warningCondition)
    $null -ne $script:warning
  } 'Recovery must visibly reject an unverified listener.'
  $warningText = ($script:warning.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name }) -join ' '
  if (-not $warningText.Contains('could not be verified')) { throw "Unexpected recovery warning: $warningText" }
  if ($unrelated.HasExited) { throw 'Recovery must not kill an unverified service on the configured port.' }
  $okCondition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'OK')
  $ok = $script:warning.FindFirst([Windows.Automation.TreeScope]::Descendants, $okCondition)
  [void][DeepDockCapture]::PostMessage([IntPtr]$ok.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  $unrelated.Kill(); $unrelated.WaitForExit()
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Status did not recover after the unrelated listener exited.'

  Click-Button 'Start bridge'
  Wait-For { $null -ne (Find-Element 'Bridge running') } 'Bridge did not restart after force stop.'
  Click-Button 'Exit'
  if (-not $process.WaitForExit(15000)) { throw 'Exit did not close the app.' }
  $probe = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'node.exe'), '"' + (Join-Path $app 'bridge-host.cjs') + '" status')
  $probe.UseShellExecute = $false; $probe.CreateNoWindow = $true; $probe.RedirectStandardOutput = $true
  $probe.EnvironmentVariables['APPDATA'] = $profile
  $check = [Diagnostics.Process]::Start($probe)
  $result = $check.StandardOutput.ReadToEnd() | ConvertFrom-Json
  $check.WaitForExit(); $check.Dispose()
  if (-not $result.ok -or $result.running) { throw 'Exit must stop the bridge before closing the app.' }
  $process.Dispose()
  $process = [Diagnostics.Process]::Start($info)
  Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Desktop window did not reopen.'
  $script:window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  Wait-For { $null -ne (Find-Element 'Bridge stopped') } 'Reopening must leave the bridge stopped.'
  Click-Button 'Start bridge'
  Wait-For { $null -ne (Find-Element 'Bridge running') } 'Bridge did not start before uninstall simulation.'
  Wait-For { (Find-Element 'Stop bridge').Current.IsEnabled } 'Bridge control did not become idle.'
  $shutdownInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'DeepDock.exe'), '--shutdown')
  $shutdownInfo.UseShellExecute = $false; $shutdownInfo.CreateNoWindow = $true
  $shutdownInfo.EnvironmentVariables['APPDATA'] = $profile
  $shutdown = [Diagnostics.Process]::Start($shutdownInfo)
  if (-not $shutdown.WaitForExit(30000) -or $shutdown.ExitCode -ne 0) { throw 'Installer shutdown failed.' }
  $shutdown.Dispose()
  if (-not $process.WaitForExit(5000)) { throw 'Installer shutdown left the tray app running.' }
  # Removing configuration must not trap an idle app or block uninstall.
  Remove-Item -LiteralPath (Join-Path $configDir 'config.json')
  $process.Dispose()
  $process = [Diagnostics.Process]::Start($info)
  Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Unconfigured app did not open.'
  $script:window = [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  Wait-For { $null -ne (Find-Element 'Bridge needs attention') } 'Missing configuration was not reported.'
  Click-Button 'Exit'
  if (-not $process.WaitForExit(15000)) { throw 'Missing configuration must not prevent Exit.' }
  $shutdown = [Diagnostics.Process]::Start($shutdownInfo)
  if (-not $shutdown.WaitForExit(15000) -or $shutdown.ExitCode -ne 0) { throw 'Missing configuration must not prevent uninstall when no bridge is running.' }
  $shutdown.Dispose()
  Write-Host "Desktop controls, legacy recovery across runtimes and paths, other-port isolation, Exit, installer shutdown, and missing-config recovery passed. Screenshots: $evidence"
} finally {
  foreach ($child in $extraProcesses) {
    if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    $child.Dispose()
  }
  if ($sentinel) {
    if (-not $sentinel.HasExited) { $sentinel.Kill(); $sentinel.WaitForExit() }
    $sentinel.Dispose()
  }
  if ($process) {
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
  }
  if ((Test-Path -LiteralPath (Join-Path $app 'bridge-host.cjs')) -and (Test-Path -LiteralPath (Join-Path $configDir 'config.json'))) {
    $cleanup = [Diagnostics.ProcessStartInfo]::new((Join-Path $app 'node.exe'), '"' + (Join-Path $app 'bridge-host.cjs') + '" stop')
    $cleanup.UseShellExecute = $false; $cleanup.CreateNoWindow = $true; $cleanup.RedirectStandardOutput = $true
    $cleanup.EnvironmentVariables['APPDATA'] = $profile
    $stop = [Diagnostics.Process]::Start($cleanup)
    $null = $stop.StandardOutput.ReadToEnd(); $stop.WaitForExit(); $stop.Dispose()
  }
  if ($null -ne $oldClipboard) { Set-Clipboard -Value $oldClipboard } else { Set-Clipboard -Value '' }
  $resolvedFixture = [IO.Path]::GetFullPath($fixture)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolvedFixture)).StartsWith('deepdock-desktop-')) { throw 'Unexpected desktop fixture path.' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
