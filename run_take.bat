@echo off
cd /d "%~dp0\ERP 隨身查與盤點"
"C:\Program Files\nodejs\node.exe" take_server.js >> take_server.log 2>&1