# 1. 複製 JS 部分內容至剪貼簿
Set-Clipboard -Value "localStorage.setItem('api_token','telcradrq0ps7q8yv5apyf');location.reload();"

# 2. 點擊 Chrome 中央取得焦點
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action click -X 1200 -Y 685
Start-Sleep -Milliseconds 300

# 3. 按 Ctrl+L 鎖定網址列
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action keypress -Key '^l'
Start-Sleep -Milliseconds 300

# 4. 按 Delete 清空
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action keypress -Key '{DELETE}'
Start-Sleep -Milliseconds 200

# 5. 用 SendKeys 逐字打入 "javascript:"
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action type -Text "javascript:"
Start-Sleep -Milliseconds 200

# 6. 用 SendKeys 貼上剩餘內容
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action keypress -Key '^v'
Start-Sleep -Milliseconds 200

# 7. 按 Enter 鍵執行
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\control_ui.ps1' -Action keypress -Key '{ENTER}'

# 8. 等待 5 秒重新整理完成，重新截圖
Start-Sleep -Seconds 5
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\screenshot.ps1'
& 'C:\Users\5Vce8\.gemini\antigravity\scratch\crop_screenshot.ps1' -Left 793 -Top 504 -Width 814 -Height 363 -Filename chrome_screenshot.png
