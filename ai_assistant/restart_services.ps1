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

# Resolve working directory dynamically to avoid Chinese path encoding issues
$parentDir = Split-Path -Parent $PSScriptRoot

$takeVbs = Join-Path $parentDir "run_take.vbs"
$queryVbs = Join-Path $parentDir "run_query.vbs"
$bridgeVbs = Join-Path $PSScriptRoot "run_bridge.vbs"

# 3. Start Node services by directly invoking VBScript wrappers using PowerShell call operator (&)
# This bypasses external command-line argument encoding conversion errors
& $takeVbs
& $queryVbs
& $bridgeVbs

Write-Output "Services restarted successfully."
