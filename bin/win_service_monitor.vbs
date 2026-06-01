Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set objShell = CreateObject("WScript.Shell")

' 1. 檢測 Port 28256 (Bot) 與 Port 3000 (Config Server) 是否在監聽
tempFile = objShell.ExpandEnvironmentStrings("%TEMP%") & "\netstat_out.txt"
On Error Resume Next
objShell.Run "cmd.exe /c netstat -ano > """ & tempFile & """", 0, True
On Error GoTo 0

isBotAlive = False
isConfigAlive = False

If fso.FileExists(tempFile) Then
    On Error Resume Next
    Set objFile = fso.OpenTextFile(tempFile, 1)
    If Err.Number = 0 Then
        Do Until objFile.AtEndOfStream
            strLine = objFile.ReadLine()
            If InStr(strLine, ":28256") > 0 And InStr(strLine, "LISTENING") > 0 Then
                isBotAlive = True
            End If
            If InStr(strLine, ":3000") > 0 And InStr(strLine, "LISTENING") > 0 Then
                isConfigAlive = True
            End If
        Loop
        objFile.Close
    End If
    fso.DeleteFile(tempFile)
    On Error GoTo 0
End If

' 若任何一個服務未在執行，執行自癒重啟
If (Not isBotAlive) Or (Not isConfigAlive) Then
    objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\..\scripts\restart_services.ps1""", 0, False
End If
