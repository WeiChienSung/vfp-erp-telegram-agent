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

Start-Sleep -Seconds 2

# 2. Start Node services via cscript.exe wrappers to avoid Session 0 GUI restriction
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_query.vbs" -WindowStyle Hidden
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_take.vbs" -WindowStyle Hidden

Write-Output "Services restarted successfully (Query Bot & Local Config Server)."
