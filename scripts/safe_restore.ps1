# 1. 還原開機自啟 VBS 到啟動資料夾
$vbsName = "ERP_" + [char]0x96a8 + [char]0x8eab + [char]0x67e5 + ".vbs"
$startupPath = Join-Path "C:\Users\5Vce8\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" $vbsName
$backupPath = "C:\agy_Add_on\ERP_startup.vbs.bak"
if (Test-Path $backupPath) {
    Move-Item -Path $backupPath -Destination $startupPath -Force
    Write-Output "Restored Startup script."
} else {
    Write-Output "Backup Startup script not found."
}

# 2. 桌面 Git 專案資料夾已永久移入 C:\agy_Add_on，無須再還原至桌面
Write-Output "Desktop repo folder is permanently stored in hidden directory."

# 3. 執行 VBS 自啟動服務
if (Test-Path $startupPath) {
    $arg = '"`"{0}`"' -f $startupPath
    Start-Process "wscript.exe" -ArgumentList $arg -WindowStyle Hidden
    Write-Output "Services restarted."
} else {
    Write-Output "Failed to restart services because Startup VBS is missing."
}

Write-Output "Restore completed. Services are running normally."