Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = "C:\agy_Add_on"
If fso.FolderExists(projectPath) Then
    Set WshShell = CreateObject("WScript.Shell")
    WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & projectPath & "\scripts\restart_services.ps1""", 0, False
End If