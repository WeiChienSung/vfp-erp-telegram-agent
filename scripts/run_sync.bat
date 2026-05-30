@echo off
cd /d "%~dp0.."
".\bin\vfp_sync_host.exe" ".\engine\sync_backorders.js" >> ".\logs\sync_backorders.log" 2>&1
