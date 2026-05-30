@echo off
chcp 65001 >nul
echo ====================================================
echo       VFP ERP 新用戶端一鍵安裝與設定程式
echo ====================================================
echo.
openfiles >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 請以「系統管理員身分」執行此批次檔！
    echo 這是因為複製系統 DLL 檔案需要系統管理員權限。
    pause
    exit /b
)
echo [1/3] 正在安裝 Visual FoxPro 運行環境...
if exist "%windir%\SysWOW64" (
    copy /y "%~dp0VFP6R.DLL" "%windir%\SysWOW64\" >nul
    copy /y "%~dp0VFP6RCHT.DLL" "%windir%\SysWOW64\" >nul
    copy /y "%~dp0VFP6RENU.DLL" "%windir%\SysWOW64\" >nul
    echo [成功] 已安裝 VFP 運行庫至 SysWOW64。
) else (
    copy /y "%~dp0VFP6R.DLL" "%windir%\System32\" >nul
    copy /y "%~dp0VFP6RCHT.DLL" "%windir%\System32\" >nul
    copy /y "%~dp0VFP6RENU.DLL" "%windir%\System32\" >nul
    echo [成功] 已安裝 VFP 運行庫至 System32。
)
echo [2/3] 正在連結 ERP 主機磁碟機 (Z:)...
net use Z: \\192.168.1.99\d /persistent:yes >nul 2>&1
if %errorlevel% equ 0 (
    echo [成功] 已成功連結 Z: 槽指向 \\192.168.1.99\d。
) else (
    echo [警告] 無法連線至 \\192.168.1.99\d，請確認網路線已接上且能 ping 通主機。
)
echo [3/3] 正在桌面建立 ERP 系統捷徑...
powershell -Command "=(New-Object -COM WScript.Shell).CreateShortcut('%userprofile%\Desktop\ERP系統.lnk');.TargetPath='Z:\nmedi\sg.exe';.WorkingDirectory='Z:\nmedi\';.Save()" >nul 2>&1
echo [成功] 已在桌面建立「ERP系統」捷徑。
echo.
echo ====================================================
echo   設定完畢！您現在可以直接按桌面「ERP系統」啟動程式。
echo ====================================================
pause
