@echo off
cd /d "%~dp0\ERP 隨身查與盤點"
"C:\Program Files\nodejs\node.exe" telegram_bot.js >> telegram_bot.log 2>&1