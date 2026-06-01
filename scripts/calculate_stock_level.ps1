# =====================================================================
# VFP ERP 智慧庫存安全水位預警觸發器 (calculate_stock_level.ps1)
# =====================================================================
$scriptPath = Join-Path $PSScriptRoot "..\engine\calculate_stock_level.js"
$hostPath = Join-Path $PSScriptRoot "..\bin\vfp_sync_host.exe"

if (Test-Path $hostPath) {
    Write-Output "Starting safe stock level calculation..."
    & $hostPath $scriptPath
} else {
    Write-Error "vfp_sync_host.exe not found at $hostPath"
}
