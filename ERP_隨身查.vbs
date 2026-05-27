Set fso = CreateObject("Scripting.FileSystemObject")

' Use exact folder name to prevent multiple-match overwrite bug
Dim exactPath
exactPath = "C:\agy_Add_on\ERP " & Chr(38568) & Chr(36523) & Chr(26597) & Chr(33287) & Chr(30424) & Chr(40670)

' Fallback: scan for first ERP subfolder if exact path not found
If fso.FolderExists(exactPath) Then
    projectPath = exactPath
Else
    projectPath = ""
    Set folder = fso.GetFolder("C:\agy_Add_on")
    For Each subfolder In folder.SubFolders
        If Left(subfolder.Name, 3) = "ERP" Then
            if projectPath = "" Then
                projectPath = subfolder.Path
            End If
        End If
    Next
End If

If projectPath <> "" Then
    Set WshShell = CreateObject("WScript.Shell")
    ' 🛡️ 移除 WshShell.CurrentDirectory = projectPath 以防 Unicode 目錄語系解析失敗
    WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & projectPath & "\restart_services.ps1""", 0, False
End If