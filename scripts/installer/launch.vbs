Option Explicit
Dim fso, shell, appData, appDir, configPath, hostPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appData = shell.ExpandEnvironmentStrings("%APPDATA%")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
configPath = fso.BuildPath(fso.BuildPath(appData, "DeepDock"), "config.json")
If Not fso.FileExists(configPath) Then WScript.Quit 1
hostPath = fso.BuildPath(appDir, "bridge-host.js")
shell.Run Chr(34) & fso.BuildPath(appDir, "node.exe") & Chr(34) & " " & Chr(34) & hostPath & Chr(34), 0, False
