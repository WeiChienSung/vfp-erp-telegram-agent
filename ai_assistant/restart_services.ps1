# 1. Force kill node processes on port 3000 and 28256
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

# 2. Clean up leftover localtunnel and bridge processes
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*localtunnel*" -or $_.CommandLine -like "*telegram_bridge.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 2

# 3. Start Node services via cscript.exe wrappers to decouple process lifecycles from parent PowerShell session
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_take.vbs" -WindowStyle Hidden
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_query.vbs" -WindowStyle Hidden
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_bridge.vbs" -WindowStyle Hidden

Write-Output "Services restarted successfully."