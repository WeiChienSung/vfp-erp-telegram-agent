# =====================================================================
# VFP ERP 行動盤點二進位寫入器 (append_take.ps1)
# =====================================================================
param(
    [string]$DbDir,
    [string]$TakeNo,
    [string]$UserCode,
    [string]$Barcode,
    [double]$Qty,
    [string]$Unit = "",
    [string]$SubUnit = "",
    [string]$Vendor = "",
    [string]$Mode = "add" # "add", "overwrite", "warn"
)

$Big5 = [System.Text.Encoding]::GetEncoding("big5")

# 格式化固定長度 Big5 位元組
function Get-PadBytes($str, $len) {
    $bytes = New-Object byte[] $len
    for ($i=0; $i -lt $len; $i++) { $bytes[$i] = 0x20 } # 填充空白
    if ($str) {
        $encoded = $Big5.GetBytes($str)
        $copyLen = [Math]::Min($encoded.Length, $len)
        [Array]::Copy($encoded, $bytes, $copyLen)
    }
    return $bytes
}

# 格式化數值至靠右對齊 Big5 欄位
function Get-NumBytes($val, $len, $decimals) {
    $fmt = "{0:F" + $decimals + "}"
    $str = [string]::Format($fmt, $val)
    $str = $str.PadLeft($len)
    return $Big5.GetBytes($str)
}

$takePath = Join-Path $DbDir "take.dbf"
$take1Path = Join-Path $DbDir "take1.dbf"

$tStream = $null
$t1Stream = $null

try {
    # 🟢 1. 預檢雙鎖 (Pre-lock Check): 試圖獨佔開啟雙檔案，防止鎖定衝突
    $tStream = [System.IO.File]::Open($takePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $t1Stream = [System.IO.File]::Open($take1Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)

    # ==========================================
    # 解析 take1.dbf 欄位結構與欄位偏移
    # ==========================================
    $hBuf1 = New-Object byte[] 32
    $t1Stream.Position = 0
    $t1Stream.Read($hBuf1, 0, 32) | Out-Null
    
    $recCount1 = [System.BitConverter]::ToInt32($hBuf1, 4)
    $headerLen1 = [System.BitConverter]::ToInt16($hBuf1, 8)
    $recLen1 = [System.BitConverter]::ToInt16($hBuf1, 10)

    # 讀取欄位描述符
    $fieldBuf1 = New-Object byte[] $headerLen1
    $t1Stream.Position = 0
    $t1Stream.Read($fieldBuf1, 0, $headerLen1) | Out-Null

    $fields = @()
    $offset = 32
    $currentRecordOffset = 1 # 排除刪除標記 (1 byte)

    while ($offset < $headerLen1 - 1) {
        if ($fieldBuf1[$offset] -eq 0x0D) { break }
        
        $nameBytes = New-Object byte[] 11
        [Array]::Copy($fieldBuf1, $offset, $nameBytes, 0, 11)
        $ne = 0
        while ($ne -lt 11 -and $nameBytes[$ne] -ne 0) { $ne++ }
        $fName = [System.Text.Encoding]::ASCII.GetString($nameBytes, 0, $ne).Trim()
        
        $fType = [char]$fieldBuf1[$offset + 11]
        $fLen = $fieldBuf1[$offset + 16]
        
        $fields += [PSCustomObject]@{
            Name   = $fName
            Type   = $fType
            Length = $fLen
            Offset = $currentRecordOffset
        }
        $currentRecordOffset += $fLen
        $offset += 32
    }

    # 取得必要欄位之偏移與長度
    $fTakeNo = $fields | Where-Object { $_.Name -ieq "take_no" }
    $fBarcode = $fields | Where-Object { $_.Name -ieq "barcode" }
    $fQty = $fields | Where-Object { $_.Name -ieq "qty" }
    $fItemNo = $fields | Where-Object { $_.Name -ieq "item_no" }

    # ==========================================
    # 2. 逆向掃描 take1.dbf 尋找重複盤點項目 (分區協作)
    # ==========================================
    $duplicateRecordIndex = -1
    $duplicateOriginalQty = 0.0
    $duplicateRecordOffset = 0

    $cleanTakeNo = $TakeNo.Trim()
    $cleanBarcode = $Barcode.Trim()

    for ($r = $recCount1 - 1; $r -ge 0; $r--) {
        $filePos = $headerLen1 + ($r * $recLen1)
        $t1Stream.Position = $filePos
        
        $isDeleted = $t1Stream.ReadByte()
        if ($isDeleted -eq 0x2A) { continue } # 跳過已刪除

        # 讀取 take_no 欄位
        $t1Stream.Position = $filePos + $fTakeNo.Offset
        $bufTakeNo = New-Object byte[] $fTakeNo.Length
        $t1Stream.Read($bufTakeNo, 0, $fTakeNo.Length) | Out-Null
        $valTakeNo = $Big5.GetString($bufTakeNo).Trim()

        # 如果發現 take_no 不相同，代表已經超出目前盤點單的範圍（因為是循序追加的），可提早結束掃描
        if ($valTakeNo -ne $cleanTakeNo) {
            break
        }

        # 讀取 barcode 欄位
        $t1Stream.Position = $filePos + $fBarcode.Offset
        $bufBarcode = New-Object byte[] $fBarcode.Length
        $t1Stream.Read($bufBarcode, 0, $fBarcode.Length) | Out-Null
        $valBarcode = $Big5.GetString($bufBarcode).Trim()

        if ($valBarcode -eq $cleanBarcode) {
            # 找到重複項！
            $duplicateRecordIndex = $r
            $duplicateRecordOffset = $filePos
            
            # 讀取現有數量
            $t1Stream.Position = $filePos + $fQty.Offset
            $bufQty = New-Object byte[] $fQty.Length
            $t1Stream.Read($bufQty, 0, $fQty.Length) | Out-Null
            $duplicateOriginalQty = [double]([string]$Big5.GetString($bufQty).Trim())
            break
        }
    }

    # ==========================================
    # 3. 重複項處理邏輯 (1C: 分區協作模式)
    # ==========================================
    if ($duplicateRecordIndex -ne -1) {
        if ($Mode -eq "warn") {
            # 警告模式：回傳重複狀態與原數量，不進行寫入
            Write-Output "DUPLICATE:$duplicateOriginalQty"
            exit 0
        }
        
        $newQty = $Qty
        if ($Mode -eq "add") {
            $newQty = $duplicateOriginalQty + $Qty
        }

        # 在原位置覆蓋數量欄位
        $t1Stream.Position = $duplicateRecordOffset + $fQty.Offset
        $newQtyBytes = Get-NumBytes $newQty $fQty.Length 2
        $t1Stream.Write($newQtyBytes, 0, $fQty.Length)

        Write-Output "UPDATED:$newQty"
        exit 0
    }

    # ==========================================
    # 4. 新增單頭 (take.dbf) 如果尚未存在
    # ==========================================
    # 解析 take.dbf 結構
    $tStream.Position = 0
    $hBuf = New-Object byte[] 32
    $tStream.Read($hBuf, 0, 32) | Out-Null
    
    $recCount = [System.BitConverter]::ToInt32($hBuf, 4)
    $headerLen = [System.BitConverter]::ToInt16($hBuf, 8)
    $recLen = [System.BitConverter]::ToInt16($hBuf, 10)

    # 檢查 take_no 是否已存在於單頭中
    $takeNoExists = $false
    for ($r = $recCount - 1; $r -ge 0; $r--) {
        $filePos = $headerLen + ($r * $recLen)
        $tStream.Position = $filePos + 1 # 跳過刪除旗標
        
        $bufTakeNo = New-Object byte[] 10 # take_no 長度為 10
        $tStream.Read($bufTakeNo, 0, 10) | Out-Null
        $valTakeNo = $Big5.GetString($bufTakeNo).Trim()

        if ($valTakeNo -eq $cleanTakeNo) {
            $takeNoExists = $true
            break
        }
    }

    if (-not $takeNoExists) {
        # 寫入單頭
        $eofPos = $headerLen + ($recCount * $recLen)
        $tStream.Position = $eofPos

        $tStream.WriteByte(0x20) # Active delete flag
        $tStream.Write((Get-PadBytes $TakeNo 10), 0, 10) # take_no
        $tStream.Write((Get-PadBytes (Get-Date -Format "yyyyMMdd") 8), 0, 8) # take_date
        $tStream.Write((Get-PadBytes $UserCode 10), 0, 10) # user_code
        $tStream.Write((Get-PadBytes "0" 1), 0, 1) # status
        $tStream.WriteByte(0x1A) # EOF marker

        # 更新單頭 Record Count
        $newRecCount = $recCount + 1
        $tStream.Position = 4
        $tStream.Write(([System.BitConverter]::GetBytes($newRecCount)), 0, 4)
    }

    # ==========================================
    # 5. 新增明細 (take1.dbf)
    # ==========================================
    $eofPos1 = $headerLen1 + ($recCount1 * $recLen1)
    $t1Stream.Position = $eofPos1

    # 寫入明細行
    $t1Stream.WriteByte(0x20) # Active delete flag
    $t1Stream.Write((Get-PadBytes $TakeNo 10), 0, 10) # take_no
    $t1Stream.Write((Get-NumBytes ($recCount1 + 1) 4 0), 0, 4) # item_no
    $t1Stream.Write((Get-PadBytes $Barcode 20), 0, 20) # barcode
    $t1Stream.Write((Get-NumBytes $Qty 10 2), 0, 10) # qty
    $t1Stream.Write((Get-PadBytes $Unit 4), 0, 4) # unit
    $t1Stream.Write((Get-PadBytes $SubUnit 4), 0, 4) # subunit
    $t1Stream.Write((Get-PadBytes $Vendor 10), 0, 10) # vendor
    $t1Stream.WriteByte(0x1A) # EOF marker

    # 更新明細 Record Count
    $newRecCount1 = $recCount1 + 1
    $t1Stream.Position = 4
    $t1Stream.Write(([System.BitConverter]::GetBytes($newRecCount1)), 0, 4)

    Write-Output "SUCCESS"
}
catch {
    Write-Output "ERROR:$($_.Exception.Message)"
}
finally {
    if ($tStream) { $tStream.Close(); $tStream.Dispose() }
    if ($t1Stream) { $t1Stream.Close(); $t1Stream.Dispose() }
}
