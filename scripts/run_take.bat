@echo off
cd /d "%~dp0.."
".\bin\vfp_sync_host.exe" ".\engine\take_server.js" >> ".\logs\take_server.log" 2>&1
