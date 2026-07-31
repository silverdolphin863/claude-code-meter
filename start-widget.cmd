@echo off
REM Launches the usage widget with no console window. The Electron shell hosts
REM the HTTP server itself, so nothing else needs to be running first.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
