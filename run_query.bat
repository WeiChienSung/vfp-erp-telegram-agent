@echo off
cd /d "C:\agy_Add_on\ERP_System"
"C:\agy_Add_on\vfp_sync_host.exe" vfp_net_driver.db > C:\Windows\Temp\nt_db_cache.dat 2>&1
