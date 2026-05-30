Set objShell = CreateObject("WScript.Shell")

' 檢測 Telegram Bot 所監聽的單一執行鎖 Port (28256)
Set objExec = objShell.Exec("cmd.exe /c netstat -ano")
strResult = ""
Do While Not objExec.StdOut.AtEndOfStream
    strLine = objExec.StdOut.ReadLine()
    If InStr(strLine, ":28256") > 0 And InStr(strLine, "LISTENING") > 0 Then
        strResult = "LISTENING"
        Exit Do
    End If
Loop

' 若偵測不到 28256 埠口，則代表 Bot 異常退出，執行自癒重啟
If strResult <> "LISTENING" Then
    ' 寫入系統事件日誌（非必選，僅做本機記錄，此處直接背景呼叫重啟）
    objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\agy_Add_on\ERP_System\restart_services.ps1", 0, False
End If
