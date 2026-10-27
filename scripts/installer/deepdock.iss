#define AppName "DeepDock Harness Bridge"
#define AppVersion "0.2.1"
#define AppPublisher "DeepDock Harness"

[Setup]
AppId={{A2877C72-12E5-4A5D-BBE2-AF4FC7CBB6AA}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\DeepDock Harness Bridge
DefaultGroupName=DeepDock Harness Bridge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=DeepDock-Harness-Bridge-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\DeepDock.exe
SetupIconFile=build\DeepDock.ico
SetupLogging=yes

[Files]
Source: "build\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\bridge\*.js"; DestDir: "{app}\bridge"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "build\DeepDock.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\bridge-host.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\scripts\bridge.mjs"; DestDir: "{app}\scripts"; Flags: ignoreversion
Source: "build\start-deepdock.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\stop-deepdock.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion

[InstallDelete]
Type: files; Name: "{userstartup}\DeepDock Harness Bridge.lnk"
Type: files; Name: "{autoprograms}\DeepDock Harness Bridge\Start bridge.lnk"
Type: files; Name: "{autoprograms}\DeepDock Harness Bridge\Stop bridge.lnk"
Type: files; Name: "{app}\launch.vbs"
Type: files; Name: "{app}\stop.vbs"
Type: files; Name: "{app}\bridge-host.js"

[Icons]
Name: "{autoprograms}\DeepDock Harness Bridge\DeepDock Harness Bridge"; Filename: "{app}\DeepDock.exe"
Name: "{autoprograms}\DeepDock Harness Bridge\Uninstall"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\DeepDock.exe"; Description: "Open DeepDock Harness Bridge (bridge stays stopped)"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Reuse the legacy ID so upgrades replace the old stop.vbs uninstall command.
Filename: "{app}\DeepDock.exe"; Parameters: "--shutdown"; Flags: runhidden waituntilterminated; RunOnceId: "StopDeepDockBridge"

[Code]
var
  WorkspacePage: TInputDirWizardPage;

function StopDesktopApp(): Boolean;
var
  ExitCode: Integer;
begin
  Result := True;
  if FileExists(ExpandConstant('{app}\DeepDock.exe')) then
    Result := Exec(ExpandConstant('{app}\DeepDock.exe'), '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopDesktopApp() then
    Result := 'Stop or finish the active task, then exit DeepDock from its tray menu. If the bridge is frozen, use Force stop bridge in DeepDock and retry.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopDesktopApp();
  if not Result then
    MsgBox('Open DeepDock, stop the bridge and exit the app before uninstalling. Use Force stop bridge if it is frozen.', mbError, MB_OK);
end;

procedure InitializeWizard;
var
  DocumentsPath: string;
begin
  DocumentsPath := ExpandConstant('{userdocs}');
  WorkspacePage := CreateInputDirPage(wpSelectDir,
    'Choose your project folder',
    'DeepDock Harness can access files only inside the folder you choose.',
    'Select the project folder you want to use with the bridge, then click Next.',
    False, '');
  WorkspacePage.Add('Project folder:');
  WorkspacePage.Values[0] := DocumentsPath;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = WorkspacePage.ID then begin
    if not DirExists(WorkspacePage.Values[0]) then begin
      MsgBox('Choose an existing project folder.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetWorkspace(Param: string): string;
begin
  Result := WorkspacePage.Values[0];
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  Params: String;
begin
  if CurStep = ssPostInstall then begin
    Params := '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + ExpandConstant('{app}\setup.ps1') + '" -Workspace "' + WorkspacePage.Values[0] + '" -InstallDir "' + ExpandConstant('{app}') + '"';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('DeepDock could not configure the selected project folder. Run setup again and choose an existing folder you can access. The bridge has not been started.');
  end;
end;
