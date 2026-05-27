# 1. 強制結束 Port 3000 和 Port 28256 上的 node 進程
$ports = @(3000, 28256)
foreach ($port in $ports) {
    $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
    foreach ($conn in $connections) {
        if ($conn.OwningProcess) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Write-Output "Stopped process $($conn.OwningProcess) on port $port"
        }
    }
}

# 2. 清理殘留的 localtunnel 進程
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*localtunnel*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# 3. 在背景啟動 take_server.js
Start-Process -FilePath "node.exe" -ArgumentList "take_server.js" -WorkingDirectory "C:\agy_Add_on\ERP 隨身查與盤點" -WindowStyle Hidden

# 4. 在背景啟動 telegram_bot.js
Start-Process -FilePath "node.exe" -ArgumentList "telegram_bot.js" -WorkingDirectory "C:\agy_Add_on\ERP 隨身查與盤點" -WindowStyle Hidden

Write-Output "Services restarted successfully."
