# =====================================================================
# VFP ERP 智慧自動備份與清理排程 (backup_erp.ps1)
# =====================================================================
$DbDir = "\\192.168.1.99\d\nmedi"
$BackupDir = "C:\ERP_Backups"
$TelegramOutbox = "C:\agy_Add_on\ai_assistant\telegram_outbox.txt"

# 1. 建立備份根目錄
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$tempWorkDir = Join-Path $BackupDir "temp_$timestamp"
$zipPath = Join-Path $BackupDir "ERP_Backup_$timestamp.zip"

New-Item -ItemType Directory -Path $tempWorkDir -Force | Out-Null

$success = $true
$errors = @()

# 2. 唯讀共享模式複製 DBF & FPT & CDX 檔案 (避開寫入衝突)
try {
    $files = Get-ChildItem $DbDir -File | Where-Object { $_.Extension -match "\.(dbf|fpt|cdx|ini)$" }
    
    foreach ($file in $files) {
        $destFile = Join-Path $tempWorkDir $file.Name
        
        $srcStream = $null
        $destStream = $null
        try {
            # 以 Read-Shared 模式開啟來源文件
            $srcStream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $destStream = [System.IO.File]::Open($destFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            
            $srcStream.CopyTo($destStream)
        }
        catch {
            $success = $false
            $errors += "無法備份 $($file.Name): $_"
        }
        finally {
            if ($srcStream) { $srcStream.Close(); $srcStream.Dispose() }
            if ($destStream) { $destStream.Close(); $destStream.Dispose() }
        }
    }

    # 3. 執行壓縮打包
    if (Test-Path $tempWorkDir) {
        Compress-Archive -Path "$tempWorkDir\*" -DestinationPath $zipPath -Force
        Remove-Item -Path $tempWorkDir -Recurse -Force | Out-Null
    }

    # 4. 滾動輪替清理 (只保留最新 7 份備份)
    $backups = Get-ChildItem $BackupDir -File | Where-Object { $_.Name -like "ERP_Backup_*.zip" } | Sort-Object LastWriteTime
    if ($backups.Count -gt 7) {
        $deleteCount = $backups.Count - 7
        for ($i = 0; $i -lt $deleteCount; $i++) {
            Remove-Item -Path $backups[$i].FullName -Force -ErrorAction SilentlyContinue
        }
    }

    # 5. 回報結果至 Telegram Outbox
    $msg = ""
    if ($success) {
        $fileSize = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
        $msg = "🚀 <b>[自動備份成功]</b>`n`nERP 資料庫已於凌晨順利歸檔。`n備份檔案: <code>ERP_Backup_$timestamp.zip</code>`n檔案大小: <b>$fileSize MB</b>`n儲存路徑: <code>C:\ERP_Backups</code>`n備份輪替: 已清理 7 天前過期備份。"
    } else {
        $errSummary = $errors -join "`n"
        $msg = "⚠️ <b>[自動備份警告]</b>`n`n備份流程已完成，但部分檔案因獨佔鎖定被跳過。`n錯誤詳情:`n<code>$errSummary</code>`n`n建議檢查分機連線或 AnyDesk 維護狀態。"
    }

    # 寫入 outbox 推送 Telegram
    $msg | Out-File -FilePath $TelegramOutbox -Encoding utf8 -Append
}
catch {
    $msg = "🚨 <b>[自動備份失敗]</b>`n`n備份程序因非預期系統錯誤中斷：`n<code>$_</code>"
    $msg | Out-File -FilePath $TelegramOutbox -Encoding utf8 -Append
}
