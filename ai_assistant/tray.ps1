Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Load JSON Translation Pack to prevent encoding syntax errors in PowerShell
$jsonPath = Join-Path $PSScriptRoot "tray_menu.json"
$menuText = Get-Content -Raw -Path $jsonPath -Encoding UTF8 | ConvertFrom-Json

# 1. Create System Tray Icon & NotifyIcon
$objNotifyIcon = New-Object System.Windows.Forms.NotifyIcon
$objNotifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$objNotifyIcon.Text = $menuText.trayText
$objNotifyIcon.Visible = $true

# Function to show notification balloon
function Show-Notification ($title, $text, $icon = "Info") {
    $objNotifyIcon.ShowBalloonTip(3000, $title, $text, [System.Windows.Forms.ToolTipIcon]::$icon)
}

# 2. Create Menus
$contextMenu = New-Object System.Windows.Forms.ContextMenu
$menuChat = New-Object System.Windows.Forms.MenuItem($menuText.menuChat)
$menuUrl = New-Object System.Windows.Forms.MenuItem($menuText.menuUrl)
$menuStop = New-Object System.Windows.Forms.MenuItem($menuText.menuStop)
$menuExit = New-Object System.Windows.Forms.MenuItem($menuText.menuExit)

# Assemble context menu items
$contextMenu.MenuItems.Add($menuChat)
$contextMenu.MenuItems.Add($menuUrl)
$contextMenu.MenuItems.Add("-")
$contextMenu.MenuItems.Add($menuStop)
$contextMenu.MenuItems.Add("-")
$contextMenu.MenuItems.Add($menuExit)

$objNotifyIcon.ContextMenu = $contextMenu

# 3. Bind Events

# Click to open Telegram chat
$menuChat.add_Click({
    Start-Process "https://t.me/agy_messenger_bot"
})

# Double click tray icon to open Telegram chat
$objNotifyIcon.add_DoubleClick({
    Start-Process "https://t.me/agy_messenger_bot"
})

# Show LocalTunnel external URL
$menuUrl.add_Click({
    $urlFile = "C:\agy_Add_on\active_url.txt"
    if (Test-Path $urlFile) {
        $url = (Get-Content $urlFile).Trim()
        [System.Windows.Forms.MessageBox]::Show(($menuText.msgBoxUrlText + $url), $menuText.msgBoxUrlTitle, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    } else {
        [System.Windows.Forms.MessageBox]::Show($menuText.msgBoxUrlEmpty, $menuText.msgBoxUrlTitle, [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning)
    }
})


# Stop all background Node.js services
$menuStop.add_Click({
    Show-Notification $menuText.notificationTitle $menuText.notificationStopping
    $script = Join-Path $PSScriptRoot "kill_leftovers.ps1"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait
    Show-Notification $menuText.notificationTitle $menuText.notificationStopped "Warning"
})

# Exit tray monitor & stop services
$menuExit.add_Click({
    # Stop background services
    $script = Join-Path $PSScriptRoot "kill_leftovers.ps1"
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait
    
    # Hide tray icon
    $objNotifyIcon.Visible = $false
    $objNotifyIcon.Dispose()
    
    # Terminate WinForms thread
    [System.Windows.Forms.Application]::Exit()
})

# 4. Auto-launch services on startup
$restartScript = Join-Path $PSScriptRoot "restart_services.ps1"
if (Test-Path $restartScript) {
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$restartScript`"" -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}

Show-Notification $menuText.notificationTitle $menuText.notificationStartup "Info"

# Keep running messages loop
[System.Windows.Forms.Application]::Run()
