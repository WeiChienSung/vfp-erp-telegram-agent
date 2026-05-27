Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\agy_Add_on\ERP 隨身查與盤點\ai_assistant"
WshShell.Run "run_bridge.bat", 0, False
