param(
    [int]$Left = 0,
    [int]$Top = 0,
    [int]$Width = 100,
    [int]$Height = 100,
    [string]$Filename = "crop.png"
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)

$srcPoint = New-Object System.Drawing.Point($Left, $Top)
$destPoint = [System.Drawing.Point]::Empty
$size = New-Object System.Drawing.Size($Width, $Height)

$graphics.CopyFromScreen($srcPoint, $destPoint, $size)

$destPath = "C:\Users\5Vce8\.gemini\antigravity\brain\c871c3ab-b241-4c32-9151-f72ab4cf2c5a\$Filename"
$bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bmp.Dispose()

Write-Output "Cropped screenshot saved to $destPath ($Width x $Height)"
