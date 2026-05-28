# 1. 還原開機自啟 VBS 到啟動資料夾
$startupPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ERP_隨身查.vbs"
$backupPath = "C:\agy_Add_on\ERP_隨身查.vbs.bak"
if (Test-Path $backupPath) {
    Move-Item -Path $backupPath -Destination $startupPath -Force
    Write-Output "Restored Startup script."
}

# 2. 還原桌面上的 Git 專案資料夾
$desktopRepo = "C:\Users\5Vce8\Desktop\vfp-erp-telegram-agent"
$hiddenRepo = "C:\agy_Add_on\vfp-erp-telegram-agent.bak"
if (Test-Path $hiddenRepo) {
    Move-Item -Path $hiddenRepo -Destination $desktopRepo -Force
    Write-Output "Restored Desktop repo folder."
}

# 3. 執行 VBS 自啟動服務
if (Test-Path $startupPath) {
    Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_query.vbs" -WindowStyle Hidden
    Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_take.vbs" -WindowStyle Hidden
    Write-Output "Services restarted."
}

Write-Output "Restore completed. Services are running normally."
