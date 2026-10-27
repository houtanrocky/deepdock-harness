@echo off
"%~dp0node.exe" "%~dp0bridge-host.cjs" start
exit /b %errorlevel%
