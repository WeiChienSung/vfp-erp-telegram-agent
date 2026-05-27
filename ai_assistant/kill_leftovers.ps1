$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if ($cmd -and ($cmd -like "*telegram_bot.js*" -or $cmd -like "*take_server.js*" -or $cmd -like "*telegram_bridge.js*")) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "Killed leftover process: $($p.ProcessId) - $cmd"
    }
}
