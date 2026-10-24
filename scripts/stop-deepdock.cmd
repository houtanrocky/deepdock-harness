@echo off
rem Request an authenticated shutdown; active tasks must be stopped in the panel first.
node "%~dp0bridge.mjs" stop
exit /b %errorlevel%
