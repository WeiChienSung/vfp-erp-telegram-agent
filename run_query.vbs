Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\agy_Add_on\ERP 隨身查與盤點"
WshShell.Run "run_query.bat", 0, False
