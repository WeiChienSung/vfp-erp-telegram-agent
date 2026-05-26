# PowerShell script to safely append a record to take.dbf and take1.dbf

param (
    [string]$JsonPath,
    [string]$DbDir
)

# Load JSON data
if (-not (Test-Path $JsonPath)) {
    Write-Error "JSON file not found: $JsonPath"
    exit 1
}

$data = Get-Content -Raw -Path $JsonPath -Encoding UTF8 | ConvertFrom-Json
$dateStr = $data.date    # YYYYMMDD
$timeStr = $data.time    # HH:MM:SS
$items = $data.items

$big5 = [System.Text.Encoding]::GetEncoding("big5")

# Helper to format field bytes
function Get-FieldBytes {
    param (
        [object]$val,
        [string]$type,
        [int]$length,
        [int]$decimals = 2
    )
    
    $valStr = ""
    if ($val -ne $null) {
        $valStr = [string]$val
    }
    
    if ($type -eq 'N') {
        # Numeric: Right-aligned, space padded
        if ($val -eq $null -or $valStr -eq "") {
            $valStr = "0"
        }
        # Format decimal places if decimals > 0
        if ($decimals -gt 0) {
            $numVal = [double]$val
            $valStr = $numVal.ToString("F" + $decimals, [System.Globalization.CultureInfo]::InvariantCulture)
        }
        $valStr = $valStr.PadLeft($length)
        return $big5.GetBytes($valStr)
    } elseif ($type -eq 'D') {
        # Date: YYYYMMDD
        $valStr = $valStr.Replace("-", "").Replace("/", "").Trim()
        if ($valStr.Length -ne 8) {
            $valStr = "        " # 8 spaces
        }
        return $big5.GetBytes($valStr)
    } else {
        # Character/Memo: Left-aligned, space padded on the right
        $bytes = $big5.GetBytes($valStr)
        $paddedBytes = New-Object byte[] $length
        for ($i = 0; $i -lt $length; $i++) {
            $paddedBytes[$i] = 32 # Space character
        }
        $copyLen = [Math]::Min($bytes.Length, $length)
        [Array]::Copy($bytes, 0, $paddedBytes, 0, $copyLen)
        return $paddedBytes
    }
}

# Function to append to take.dbf
function Append-To-Take {
    param (
        [string]$dbPath,
        [string]$date,
        [string]$time
    )
    
    if (-not (Test-Path $dbPath)) {
        Write-Error "Database not found: $dbPath"
        return
    }
    
    $stream = [System.IO.File]::Open($dbPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
    
    # Read header info
    $headerBytes = New-Object byte[] 32
    $stream.Seek(0, [System.IO.SeekOrigin]::Begin) > $null
    $stream.Read($headerBytes, 0, 32) > $null
    
    $recordCount = [System.BitConverter]::ToInt32($headerBytes, 4)
    $headerLength = [System.BitConverter]::ToInt16($headerBytes, 8)
    $recordLength = [System.BitConverter]::ToInt16($headerBytes, 10)
    
    # Check if this date already exists in take.dbf (Optimize: scan only the last 100 records from the tail to avoid massive network transfer)
    $exists = $false
    if ($recordCount -gt 0) {
        $scanCount = [Math]::Min(100, $recordCount)
        $startIndex = $recordCount - $scanCount
        
        $totalRecordBytes = $scanCount * $recordLength
        $allRecordsBuf = New-Object byte[] $totalRecordBytes
        $startPos = $headerLength + ($startIndex * $recordLength)
        $stream.Seek($startPos, [System.IO.SeekOrigin]::Begin) > $null
        $readBytes = $stream.Read($allRecordsBuf, 0, $totalRecordBytes)
        
        for ($r = 0; $r -lt $scanCount; $r++) {
            $offsetInBuf = $r * $recordLength
            if ($offsetInBuf + $recordLength -gt $allRecordsBuf.Length) { break }
            if ($allRecordsBuf[$offsetInBuf] -eq 0x2A) { continue } # deleted
            
            # DAT starts at index 3 in record (DEL: 1, OK: 1, DEL: 1 -> DAT)
            $recordDate = $big5.GetString($allRecordsBuf, $offsetInBuf + 3, 8).Trim()
            if ($recordDate -eq $date) {
                $exists = $true
                Write-Host "Header for date $date already exists in take.dbf"
                break
            }
        }
    }
    
    if (-not $exists) {
        Write-Host "Appending new header for date $date in take.dbf"
        $newCount = $recordCount + 1
        
        # Format new record bytes
        $recordBytes = New-Object byte[] $recordLength
        $recordBytes[0] = 0x20 # active
        
        # OK (N,1) -> "1" (offset 1)
        $okBytes = Get-FieldBytes 1 'N' 1 0
        [Array]::Copy($okBytes, 0, $recordBytes, 1, 1)
        
        # DEL (C,1) -> " " (offset 2)
        $delBytes = Get-FieldBytes "" 'C' 1
        [Array]::Copy($delBytes, 0, $recordBytes, 2, 1)
        
        # DAT (D,8) -> date (offset 3)
        $dBytes = Get-FieldBytes $date 'D' 8
        [Array]::Copy($dBytes, 0, $recordBytes, 3, 8)
        
        # TIME (C,8) -> time (offset 11)
        $tBytes = Get-FieldBytes $time 'C' 8
        [Array]::Copy($tBytes, 0, $recordBytes, 11, 8)
        
        # Write record
        $writePos = $headerLength + ($recordCount * $recordLength)
        $stream.Seek($writePos, [System.IO.SeekOrigin]::Begin) > $null
        $stream.Write($recordBytes, 0, $recordLength)
        
        # Write EOF byte
        $stream.WriteByte(0x1A)
        
        # Update record count in header
        $stream.Seek(4, [System.IO.SeekOrigin]::Begin) > $null
        $countBytes = [System.BitConverter]::GetBytes($newCount)
        $stream.Write($countBytes, 0, 4)
    }
    
    $stream.Close()
}

# Function to append items to take1.dbf
function Append-To-Take1 {
    param (
        [string]$dbPath,
        [string]$date,
        [string]$time,
        [array]$items
    )
    
    if (-not (Test-Path $dbPath)) {
        Write-Error "Database not found: $dbPath"
        return
    }
    
    $stream = [System.IO.File]::Open($dbPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::ReadWrite)
    
    # Read header info
    $headerBytes = New-Object byte[] 32
    $stream.Seek(0, [System.IO.SeekOrigin]::Begin) > $null
    $stream.Read($headerBytes, 0, 32) > $null
    
    $recordCount = [System.BitConverter]::ToInt32($headerBytes, 4)
    $headerLength = [System.BitConverter]::ToInt16($headerBytes, 8)
    $recordLength = [System.BitConverter]::ToInt16($headerBytes, 10)
    
    # Parse fields to get names and lengths/offsets
    $fields = @()
    $offset = 32
    $currentRecordOffset = 1
    
    # Read field descriptors
    $fieldHeaderBytes = New-Object byte[] $headerLength
    $stream.Seek(0, [System.IO.SeekOrigin]::Begin) > $null
    $stream.Read($fieldHeaderBytes, 0, $headerLength) > $null
    
    while ($offset -lt $headerLength - 1) {
        if ($fieldHeaderBytes[$offset] -eq 0x0D) { break }
        
        $nameBytes = New-Object byte[] 11
        [Array]::Copy($fieldHeaderBytes, $offset, $nameBytes, 0, 11)
        $ne = 0
        while ($ne -lt 11 -and $nameBytes[$ne] -ne 0) { $ne++ }
        $name = [System.Text.Encoding]::ASCII.GetString($nameBytes, 0, $ne).Trim()
        
        $type = [char]$fieldHeaderBytes[$offset + 11]
        $len = $fieldHeaderBytes[$offset + 16]
        $dec = $fieldHeaderBytes[$offset + 17]
        
        $fields += [PSCustomObject]@{
            name   = $name
            type   = $type
            length = $len
            dec    = $dec
            offset = $currentRecordOffset
        }
        
        $currentRecordOffset += $len
        $offset += 32
    }
    
    $currentCount = $recordCount

    # 🛡️ 重複寫入防護：局部掃描最近 5000 筆記錄 (大約 1MB)，避開在網路上傳輸數十萬筆歷史記錄 (130MB+) 的致命延遲
    $existingKeys = @{}
    $mnoField = $fields | Where-Object { $_.name -eq 'MNO' }
    $datField = $fields | Where-Object { $_.name -eq 'DAT' }
    if ($mnoField -and $datField -and $recordCount -gt 0) {
        $scanCount = [Math]::Min(5000, $recordCount)
        $startIndex = $recordCount - $scanCount
        
        $totalRecordBytes = $scanCount * $recordLength
        $allRecordsBuf = New-Object byte[] $totalRecordBytes
        $startPos = $headerLength + ($startIndex * $recordLength)
        $stream.Seek($startPos, [System.IO.SeekOrigin]::Begin) > $null
        $readBytes = $stream.Read($allRecordsBuf, 0, $totalRecordBytes)
        
        for ($r = 0; $r -lt $scanCount; $r++) {
            $offsetInBuf = $r * $recordLength
            if ($offsetInBuf + $recordLength -gt $allRecordsBuf.Length) { break }
            if ($allRecordsBuf[$offsetInBuf] -eq 0x2A) { continue } # deleted record
            
            $existMno = $big5.GetString($allRecordsBuf, $offsetInBuf + $mnoField.offset, $mnoField.length).Trim()
            $existDat = $big5.GetString($allRecordsBuf, $offsetInBuf + $datField.offset, $datField.length).Trim()
            $key = "$existDat|$existMno"
            if ($existingKeys -eq $null) {
                $existingKeys = @{}
            }
            $existingKeys[$key] = $true
        }
        Write-Host "take1.dbf existing key count in scan window: $($existingKeys.Count) (scanned $scanCount records from end)"
    }

    $skippedCount = 0
    foreach ($item in $items) {
        # 檢查是否已存在相同日期+品號的明細
        $key = "$date|$($item.mno)"
        if ($existingKeys.ContainsKey($key)) {
            Write-Host "Skipping duplicate: $key (already in take1.dbf)"
            $skippedCount++
            continue
        }
        $recordBytes = New-Object byte[] $recordLength
        $recordBytes[0] = 0x20 # active
        
        # Fill fields
        foreach ($f in $fields) {
            $val = $null
            $decimals = $f.dec
            
            # Map JSON properties to DBF fields
            switch ($f.name) {
                'CK' { $val = 1; $decimals = 0 }
                'DEL' { $val = "" }
                'DAT' { $val = $date }
                'TIME' { $val = $time }
                'MNO' { $val = $item.mno }
                'BNO' { $val = $item.bno }
                'BNO1' { $val = "" }
                'SNO' { $val = $item.sno }
                'MNAME' { $val = $item.mname }
                'SCAL' { $val = $item.scal }
                'STNO' { $val = "" }
                'Q1' { $val = $item.q1; $decimals = 2 }
                'Q0' { $val = $item.q0; $decimals = 2 }
                'QUT' { $val = $item.qut; $decimals = 2 }
                'UNIT' { $val = $item.unit }
                'UNITS' { $val = $item.units }
                'QU1' { $val = "" }
                'QU0' { $val = "" }
                'QUT1' { $val = [string]$item.qut }
                'PUPRI' { $val = $item.pupri; $decimals = 2 }
            }
            
            $fBytes = Get-FieldBytes $val $f.type $f.length $decimals
            [Array]::Copy($fBytes, 0, $recordBytes, $f.offset, $f.length)
        }
        
        # Write record
        $writePos = $headerLength + ($currentCount * $recordLength)
        $stream.Seek($writePos, [System.IO.SeekOrigin]::Begin) > $null
        $stream.Write($recordBytes, 0, $recordLength)
        
        $currentCount++
    }
    
    # Write EOF byte
    $stream.WriteByte(0x1A)
    
    # Update record count in header
    $stream.Seek(4, [System.IO.SeekOrigin]::Begin) > $null
    $countBytes = [System.BitConverter]::GetBytes($currentCount)
    $stream.Write($countBytes, 0, 4)
    
    $stream.Close()
    
    $writtenCount = $items.Count - $skippedCount
    Write-Host "Successfully appended $writtenCount items to take1.dbf (skipped $skippedCount duplicates). New record count: $currentCount"
}


# Run the appends
if (-not $DbDir) {
    $DbDir = "Z:\nmedi"
}

$takePath = Join-Path $DbDir "take.dbf"
$take1Path = Join-Path $DbDir "take1.dbf"

if (-not (Test-Path $takePath)) {
    Write-Error "Database not found: $takePath"
    exit 1
}
if (-not (Test-Path $take1Path)) {
    Write-Error "Database not found: $take1Path"
    exit 1
}

try {
    Append-To-Take $takePath $dateStr $timeStr
    Append-To-Take1 $take1Path $dateStr $timeStr $items
} catch {
    Write-Error "寫入 DBF 失敗。錯誤: $($_.Exception.Message)`nStack: $($_.ScriptStackTrace)"
    exit 1
}



Write-Host "DBF Append completed successfully!"
