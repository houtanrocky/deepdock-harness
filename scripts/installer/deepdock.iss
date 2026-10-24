#define AppName "DeepDock Bridge"
#define AppVersion "0.1.0"
#define AppPublisher "DeepDock"

[Setup]
AppId={{A2877C72-12E5-4A5D-BBE2-AF4FC7CBB6AA}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\DeepDock Bridge
DefaultGroupName=DeepDock Bridge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=DeepDock-Bridge-Setup-{#AppVersion}-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
SetupLogging=yes

[Tasks]
Name: "autostart"; Description: "Start the bridge automatically when I sign in"; GroupDescription: "Startup:"; Flags: checkedonce

[Files]
Source: "build\node.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\bridge\*.js"; DestDir: "{app}\bridge"; Flags: ignoreversion
Source: "build\bridge-host.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\launch.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\stop.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\setup.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\DeepDock Bridge\Start bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""
Name: "{autoprograms}\DeepDock Bridge\Stop bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop.vbs"""
Name: "{autoprograms}\DeepDock Bridge\Uninstall"; Filename: "{uninstallexe}"
Name: "{userstartup}\DeepDock Bridge"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launch.vbs"""; Tasks: autostart

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\setup.ps1"" -Workspace ""{code:GetWorkspace}"" -InstallDir ""{app}"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\stop.vbs"""; Flags: runhidden; RunOnceId: "StopDeepDockBridge"

[Code]
var
  WorkspacePage: TInputDirWizardPage;

procedure InitializeWizard;
var
  DocumentsPath: string;
begin
  DocumentsPath := ExpandConstant('{userdocs}');
  WorkspacePage := CreateInputDirPage(wpSelectDir,
    'Choose your project folder',
    'DeepDock can access files only inside the folder you choose.',
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
