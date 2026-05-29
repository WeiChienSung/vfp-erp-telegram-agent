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
# 使用 Unicode 字元轉義以防止編碼問題導致 Path 為 Null
$vbsName = "ERP_" + [char]0x96a8 + [char]0x8eab + [char]0x67e5 + ".vbs"
$startupPath = Join-Path "C:\Users\5Vce8\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup" $vbsName
$backupPath = "C:\agy_Add_on\ERP_startup.vbs.bak"
if (Test-Path $startupPath) {
    Move-Item -Path $startupPath -Destination $backupPath -Force
    Write-Output "Moved Startup script to backup location."
} else {
    Write-Output "Startup script not found at $startupPath (possibly already hidden or path mismatch)."
}

# 3. 桌面 Git 專案資料夾已永久移入 C:\agy_Add_on，無須再進行移動隱藏
Write-Output "Desktop repo folder is permanently stored in hidden directory."

Write-Output "Safe Hide Mode activated. All running services stopped and desktop/startup files hidden."
