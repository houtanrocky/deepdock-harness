@echo off
"%~dp0node.exe" "%~dp0bridge-host.cjs" stop
exit /b %errorlevel%
