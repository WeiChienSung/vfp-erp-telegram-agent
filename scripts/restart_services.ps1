# 0. Sleep 15 seconds to wait for network/NAS to be ready on boot
Start-Sleep -Seconds 15

# 1. Force kill node processes on port 28256 (Bot) and port 3000 (Config Server)
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

# 2. Kill any running telegram_bridge.js processes
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*telegram_bridge.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped telegram_bridge.js process $($_.ProcessId)"
}

# 2.1 Kill any running vfp_net_driver.db processes
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*vfp_net_driver.db*" -or $_.CommandLine -like "*telegram_bot.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped db/bot process $($_.ProcessId)"
}

Start-Sleep -Seconds 2

# 3. Start Node services via wscript.exe wrappers to avoid Session 0 GUI restriction
wscript.exe "$PSScriptRoot\run_query.vbs"
wscript.exe "$PSScriptRoot\run_take.vbs"
wscript.exe "$PSScriptRoot\run_bridge.vbs"

Write-Output "Services restarted successfully (Query Bot, Local Config Server & AI Bridge)."

