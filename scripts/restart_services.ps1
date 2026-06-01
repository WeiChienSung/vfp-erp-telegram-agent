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

# 2.1 Kill any running vfp_net_driver.db processes
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*vfp_net_driver.db*" -or $_.CommandLine -like "*telegram_bot.js*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    Write-Output "Stopped db/bot process $($_.ProcessId)"
}

Start-Sleep -Seconds 2

# 3. Start Node services via WMI to escape Task Scheduler Job Object limits and ensure background persistence
function Safe-StartProcess {
    param([string]$cmd)
    try {
        Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd } -ErrorAction Stop | Out-Null
        Write-Output "Started process via WMI: $cmd"
    } catch {
        # Fallback if WMI fails
        Write-Warning "WMI process creation failed, falling back to Start-Process: $_"
        $parts = $cmd -split ' ', 2
        if ($parts.Length -eq 2) {
            # Strip outer quotes if any
            $filePath = $parts[0].Trim('"')
            $argList = $parts[1]
            Start-Process -FilePath $filePath -ArgumentList $argList
        } else {
            Start-Process -FilePath $cmd.Trim('"')
        }
    }
}

Safe-StartProcess "wscript.exe `"$PSScriptRoot\run_query.vbs`""
Safe-StartProcess "wscript.exe `"$PSScriptRoot\run_take.vbs`""

Write-Output "Services restarted successfully (Query Bot & Local Config Server)."


