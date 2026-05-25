# Get events from Application and System logs in the last 1 hour
$startTime = (Get-Date).AddHours(-1)

Write-Host "Searching Application Log..."
try {
    $events = Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$startTime; Level=1,2} -ErrorAction SilentlyContinue
    foreach ($e in $events) {
        if ($e.Message -like "*記憶體*" -or $e.Message -like "*memory*" -or $e.Message -like "*node*" -or $e.Message -like "*script*") {
            Write-Host "Time: $($e.TimeCreated)"
            Write-Host "Source: $($e.ProviderName)"
            Write-Host "Message: $($e.Message)"
            Write-Host "----------------------------------"
        }
    }
} catch {
    Write-Host "Error reading Application log: $_"
}

Write-Host "Searching System Log..."
try {
    $events = Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$startTime; Level=1,2} -ErrorAction SilentlyContinue
    foreach ($e in $events) {
        if ($e.Message -like "*記憶體*" -or $e.Message -like "*memory*" -or $e.Message -like "*node*" -or $e.Message -like "*script*") {
            Write-Host "Time: $($e.TimeCreated)"
            Write-Host "Source: $($e.ProviderName)"
            Write-Host "Message: $($e.Message)"
            Write-Host "----------------------------------"
        }
    }
} catch {
    Write-Host "Error reading System log: $_"
}
