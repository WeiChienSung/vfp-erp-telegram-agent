Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
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
    ' 執行自癒重啟
    objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\..\scripts\restart_services.ps1""", 0, False
End If
