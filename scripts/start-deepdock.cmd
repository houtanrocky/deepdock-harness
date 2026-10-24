@echo off
rem Start or refresh an idle DeepDock bridge.
node "%~dp0bridge.mjs" start
exit /b %errorlevel%
