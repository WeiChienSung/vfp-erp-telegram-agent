@echo off
cd /d "%~dp0.."
".\bin\vfp_sync_host.exe" ".\ai_assistant\telegram_bridge.js" >> ".\logs\telegram_bridge.log" 2>&1
