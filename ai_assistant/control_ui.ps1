param(
    [string]$Action,      # "click", "type", "move", "keypress"
    [int]$X = 0,
    [int]$Y = 0,
    [string]$Text = "",
    [string]$Key = ""
)

# 載入 Windows API 模擬滑鼠
$signature = @"
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);

[DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
"@

$user32 = Add-Type -MemberDefinition $signature -Name "User32Mouse" -Namespace "Win32" -PassThru

# 定義 mouse_event 的 flags
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP   = 0x0004

function Click-Mouse ($posX, $posY) {
    [Win32.User32Mouse]::SetCursorPos($posX, $posY)
    Start-Sleep -Milliseconds 100
    [Win32.User32Mouse]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 50
    [Win32.User32Mouse]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 100
}

function Move-Mouse ($posX, $posY) {
    [Win32.User32Mouse]::SetCursorPos($posX, $posY)
}

function Type-Text ($txt) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait($txt)
}

switch ($Action) {
    "click" {
        Click-Mouse $X $Y
        Write-Output "Clicked at ($X, $Y)"
    }
    "move" {
        Move-Mouse $X $Y
        Write-Output "Moved cursor to ($X, $Y)"
    }
    "type" {
        Type-Text $Text
        Write-Output "Typed text: $Text"
    }
    "keypress" {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait($Key)
        Write-Output "Pressed key: $Key"
    }
}
