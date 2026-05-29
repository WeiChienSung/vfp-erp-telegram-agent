Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 獲取主螢幕解析度
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$width = $bounds.Width
$height = $bounds.Height

# 擷取螢幕畫面
$bmp = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

# 儲存至 Artifact 目錄
$destPath = "C:\Users\5Vce8\.gemini\antigravity\brain\c871c3ab-b241-4c32-9151-f72ab4cf2c5a\desktop_screenshot.png"
$bmp.Save($destPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bmp.Dispose()

Write-Output "Screenshot saved to $destPath ($width x $height)"
