# =====================================================================
# Visual FoxPro ERP 隨身查 - 分機連線偵測雷達 (locks_radar.ps1)
# =====================================================================
# 說明：定期檢測本機的 AnyDesk 與 RDP 連線狀態，並同步鎖定狀態至 NAS。
# =====================================================================

$NAS_LOCKS_DIR = "\\192.168.1.99\d\nmedi\locks"
$COMPUTER_NAME = $env:COMPUTERNAME
$LOCK_FILE = Join-Path $NAS_LOCKS_DIR "$COMPUTER_NAME.lock"

# AnyDesk 日誌追蹤路徑 (相容使用者模式與服務模式安裝)
$tracePaths = @(
    "$env:APPDATA\AnyDesk\ad.trace",
    "C:\ProgramData\AnyDesk\ad.trace"
)

# 1. 檢測 AnyDesk 連線狀態
function Get-AnyDeskStatus {
    # 優先檢測 TCP 7070 埠 (AnyDesk 直連與控制通道) 是否處於 Established 狀態
    $anydeskConns = Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {
        ($_.LocalPort -eq 7070 -or $_.RemotePort -eq 7070) -and $_.State -eq "Established"
    }
    if ($anydeskConns) { return $true }

    # 解析 AnyDesk 追蹤日誌檔的末端內容，判斷 session 狀態
    foreach ($path in $tracePaths) {
        if (Test-Path $path) {
            try {
                $lines = Get-Content $path -Tail 50 -ErrorAction SilentlyContinue
                if ($lines) {
                    $lastStartedIdx = -1
                    $lastEndedIdx = -1
                    for ($i = 0; $i -lt $lines.Length; $i++) {
                        # 捕捉 Session 開始標記
                        if ($lines[$i] -match "Session started" -or $lines[$i] -match "Incoming session" -or $lines[$i] -match "app.session - Connection established") {
                            $lastStartedIdx = $i
                        }
                        # 捕捉 Session 結束標記
                        if ($lines[$i] -match "Session ended" -or $lines[$i] -match "Session closed" -or $lines[$i] -match "closed connection") {
                            $lastEndedIdx = $i
                        }
                    }
                    # 若 Session 開始的索引大於結束的索引，代表目前連線仍活躍
                    if ($lastStartedIdx -gt $lastEndedIdx) {
                        return $true
                    }
                }
            } catch {}
        }
    }
    return $false
}

# 2. 檢測 RDP 連線狀態
function Get-RdpStatus {
    # 檢測 TCP 3389 埠 (RDP) 是否有已連線的 Session
    $rdpConns = Get-NetTCPConnection -LocalPort 3389 -State Established -ErrorAction SilentlyContinue
    if ($rdpConns) { return $true }
    
    # 透過 qwinsta (Query User Session) 檢測是否有活躍的 RDP 使用者
    try {
        $sessions = qwinsta 2>$null | Select-String "Active"
        foreach ($session in $sessions) {
            if ($session -match "rdp") { return $true }
        }
    } catch {}
    return $false
}

# 主輪詢迴圈 (每 10 秒執行一次)
while ($true) {
    $anydeskActive = Get-AnyDeskStatus
    $rdpActive = Get-RdpStatus
    
    if ($anydeskActive -or $rdpActive) {
        # 確保 NAS 鎖定目錄存在
        if (-not (Test-Path $NAS_LOCKS_DIR)) {
            try {
                New-Item -ItemType Directory -Path $NAS_LOCKS_DIR -Force -ErrorAction SilentlyContinue | Out-Null
            } catch {}
        }
        
        # 寫入或更新鎖定檔 (Touch)
        if (Test-Path $NAS_LOCKS_DIR) {
            try {
                $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
                $timestamp | Out-File -FilePath $LOCK_FILE -Encoding ascii -Force
                # Write-Output "[$timestamp] 偵測到遠端連線活躍"
            } catch {}
        }
    } else {
        # 連線關閉，主動刪除鎖定檔
        if (Test-Path $LOCK_FILE) {
            try {
                Remove-Item -Path $LOCK_FILE -Force -ErrorAction SilentlyContinue
            } catch {}
        }
    }
    
    Start-Sleep -Seconds 10
}
