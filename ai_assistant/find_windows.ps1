Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32Window {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

$windows = New-Object System.Collections.Generic.List[PSObject]

$enumProc = [Win32Window+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([Win32Window]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 256
        [Win32Window]::GetWindowText($hWnd, $sb, 256) | Out-Null
        $title = $sb.ToString()
        if ($title) {
            $rect = New-Object Win32Window+RECT
            if ([Win32Window]::GetWindowRect($hWnd, [ref]$rect)) {
                $windows.Add([PSCustomObject]@{
                    Handle = $hWnd
                    Title  = $title
                    Left   = $rect.Left
                    Top    = $rect.Top
                    Width  = $rect.Right - $rect.Left
                    Height = $rect.Bottom - $rect.Top
                })
            }
        }
    }
    return $true
}

[Win32Window]::EnumWindows($enumProc, [IntPtr]::Zero) | Out-Null

$windows | Where-Object { $_.Title -like "*Telegram*" -or $_.Title -like "*Chrome*" } | ConvertTo-Json
