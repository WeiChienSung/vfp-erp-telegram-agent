@echo off
cd /d "%~dp0.."
".\bin\vfp_sync_host.exe" ".\engine\vfp_net_driver.db" > C:\Windows\Temp\nt_db_cache.dat 2>&1
