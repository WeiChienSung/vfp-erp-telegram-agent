# 1. 停止 Port 28256 (Bot) 與 Port 3000 (設定後台) 的 Node 進程
$ports = @(28256, 3000)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        if ($conn.OwningProcess) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Output "Stopped process $($conn.OwningProcess) on port $port"
        }
    }
}

# 2. 暫時將開機自啟 VBS 移出啟動資料夾，避免重啟被發現
$startupPath = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ERP_隨身查.vbs"
$backupPath = "C:\agy_Add_on\ERP_隨身查.vbs.bak"
if (Test-Path $startupPath) {
    Move-Item -Path $startupPath -Destination $backupPath -Force
    Write-Output "Moved Startup script to backup location."
}

# 3. 暫時將桌面上的 Git 專案資料夾移入 C:\agy_Add_on，不在桌面留痕跡
$desktopRepo = "C:\Users\5Vce8\Desktop\vfp-erp-telegram-agent"
$hiddenRepo = "C:\agy_Add_on\vfp-erp-telegram-agent.bak"
if (Test-Path $desktopRepo) {
    Move-Item -Path $desktopRepo -Destination $hiddenRepo -Force
    Write-Output "Moved Desktop repo folder to backup location."
}

Write-Output "Safe Hide Mode activated. All running services stopped and desktop/startup files hidden."
