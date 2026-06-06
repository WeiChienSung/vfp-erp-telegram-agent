# =====================================================================
# VFP ERP 每天早上10點自動備份與清理排程 (backup_daily.ps1)
# =====================================================================

$folderName = [char]21807 + [char]35712 + [char]20633 + [char]20221
$BackupDir = "D:\01_$folderName"
$sources = @{
    "nmedi"  = "\\192.168.1.99\d\nmedi"
    "nmedi1" = "\\192.168.1.99\d\nmedi1"
}

$logFolder = Join-Path (Split-Path $PSScriptRoot -Parent) "logs"
if (-not (Test-Path $logFolder)) {
    New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
}

$logPath = Join-Path $logFolder "backup_daily.log"
Start-Transcript -Path $logPath -Append

Write-Output "=========================================="
Write-Output "Backup started at: $(Get-Date)"

# Create backup destination if not exist
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$tempWorkDir = Join-Path $BackupDir "temp_$timestamp"
$zipPath = Join-Path $BackupDir "ERP_Backup_$timestamp.zip"

New-Item -ItemType Directory -Path $tempWorkDir -Force | Out-Null

$success = $true
$errors = @()

foreach ($key in $sources.Keys) {
    $srcDir = $sources[$key]
    $destSubDir = Join-Path $tempWorkDir $key
    New-Item -ItemType Directory -Path $destSubDir -Force | Out-Null
    
    Write-Output "Copying $key from $srcDir..."
    if (Test-Path $srcDir) {
        $files = Get-ChildItem $srcDir -File | Where-Object { $_.Extension -match "\.(dbf|fpt|cdx)$" }
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

# Compress into a ZIP archive
if ($success -or (Test-Path $tempWorkDir)) {
    Write-Output "Compressing archive to $zipPath..."
    try {
        Compress-Archive -Path "$tempWorkDir\*" -DestinationPath $zipPath -Force
        Write-Output "Compression complete. Archive size: $([Math]::Round((Get-Item $zipPath).Length / 1MB, 2)) MB"
    } catch {
        Write-Error "Failed to compress archive: $_"
    } finally {
        Remove-Item -Path $tempWorkDir -Recurse -Force -ErrorAction SilentlyContinue | Out-Null
    }
}

# Keep only the latest 7 backup files
try {
    $backups = Get-ChildItem $BackupDir -File | Where-Object { $_.Name -like "ERP_Backup_*.zip" } | Sort-Object LastWriteTime
    if ($backups.Count -gt 7) {
        $deleteCount = $backups.Count - 7
        Write-Output "Cleaning up $deleteCount old backup(s)..."
        for ($i = 0; $i -lt $deleteCount; $i++) {
            Remove-Item -Path $backups[$i].FullName -Force -ErrorAction SilentlyContinue
            Write-Output "Deleted old backup: $($backups[$i].Name)"
        }
    }
} catch {
    Write-Warning "Failed to rotate old backups: $_"
}

Write-Output "Backup completed. Success Status: $success"
if ($errors.Count -gt 0) {
    Write-Warning "Errors occurred during backup:`n$($errors -join "`n")"
}
Write-Output "=========================================="
Stop-Transcript
