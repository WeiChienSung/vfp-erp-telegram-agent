@echo off
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File D:\03_AI_????\scripts\backup_daily.ps1' -Verb RunAs"
