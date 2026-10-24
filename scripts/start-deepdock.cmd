@echo off
rem Start or refresh an idle DeepDock Harness bridge.
node "%~dp0bridge.mjs" start
exit /b %errorlevel%
