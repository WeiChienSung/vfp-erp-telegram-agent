# 1. Force kill node processes on port 28256 (Bot Single Instance Lock)
$port = 28256
$connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
    if ($conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Output "Stopped process $($conn.OwningProcess) on port $port"
    }
}

Start-Sleep -Seconds 2

# 2. Start Node services via cscript.exe wrappers to avoid Session 0 GUI restriction
Start-Process "cscript.exe" -ArgumentList "C:\agy_Add_on\run_query.vbs" -WindowStyle Hidden

Write-Output "Services restarted successfully (Query Bot only)."
