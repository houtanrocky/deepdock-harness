Option Explicit
Dim fso, shell, appDir, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = Chr(34) & fso.BuildPath(appDir, "node.exe") & Chr(34) & " " & Chr(34) & fso.BuildPath(appDir, "bridge-host.js") & Chr(34) & " stop"
shell.Run command, 0, False
