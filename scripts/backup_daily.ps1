# =====================================================================
# VFP ERP 每天早上10點自動備份 (backup_daily.ps1)
# =====================================================================

$folderName = [char]21807 + [char]35712 + [char]20633 + [char]20221  # 唯讀備份
$BackupDir = "D:\01_$folderName"
$sources = @{
    "nmedi"  = "\\192.168.1.99\d\nmedi"
    "nmedi1" = "\\192.168.1.99\d\nmedi1"
}

$logFolder = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logFolder)) {
    New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
}

$logPath = Join-Path $logFolder "backup_daily.log"
Start-Transcript -Path $logPath -Append

Write-Output "=========================================="
Write-Output "Backup started at: $(Get-Date)"

# Get Minguo Date (民國日期)
$date = Get-Date
$minguoYear = $date.Year - 1911
$minguoDate = "{0}{1}" -f $minguoYear, ($date.ToString("MMdd"))

$success = $true
$errors = @()

foreach ($key in $sources.Keys) {
    $srcDir = $sources[$key]
    
    # Folder name format: key_[MinguoDate]bak (e.g., nmedi_1150606bak)
    $destSubDirName = "${key}_${minguoDate}bak"
    $destSubDir = Join-Path $BackupDir $destSubDirName
    
    Write-Output "Backing up $key to $destSubDir..."
    
    if (Test-Path $srcDir) {
        # Create folder if not exist
        if (-not (Test-Path $destSubDir)) {
            New-Item -ItemType Directory -Path $destSubDir -Force | Out-Null
        }
        
        $files = Get-ChildItem $srcDir -File | Where-Object { $_.Extension -match "\.(dbf|fpt|cdx|ini)$" }
        foreach ($file in $files) {
            $destFile = Join-Path $destSubDir $file.Name
            $srcStream = $null
            $destStream = $null
            try {
                $srcStream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $destStream = [System.IO.File]::Open($destFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                $srcStream.CopyTo($destStream)
            }
            catch {
                $success = $false
                $errors += "Failed to copy $($file.Name): $_"
            }
            finally {
                if ($srcStream) { $srcStream.Close(); $srcStream.Dispose() }
                if ($destStream) { $destStream.Close(); $destStream.Dispose() }
            }
        }
    } else {
        $success = $false
        $errors += "Source path not found: $srcDir"
    }
}

Write-Output "Backup completed. Success Status: $success"
if ($errors.Count -gt 0) {
    Write-Warning "Errors occurred during backup:`n$($errors -join "`n")"
}
Write-Output "=========================================="
Stop-Transcript
