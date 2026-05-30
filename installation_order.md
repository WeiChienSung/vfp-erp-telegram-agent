# 🛠️ ERP 隨身助手與防禦外掛 - 從零開始完整安裝順序 (Full Installation Order)

當您在一台全新、乾淨的電腦上，想要從頭部署整套 `C:\agy_Add_on` 外掛系統時，建議的安裝與設定順序如下。本指南已由後端、系統與安全架構師共同審查並完成防呆加固：

---

## 📌 【第一階段：主機環境與網路共用準備】
在要作為「主機（或與 ERP 伺服器相連）」的電腦上執行：

1.  **安裝 Node.js**：
    *   下載並安裝 Node.js 官方 LTS 版本。
2.  **安裝 Git**：
    *   下載並安裝 Git 用於程式碼同步。
3.  **設定網路與共用權限**：
    *   確保主機能夠順利透過共用路徑讀寫 NAS 資料夾 `\\192.168.1.99\d\nmedi\`。
    *   特別確認能在 NAS 下建立名為 `locks` 的資料夾。
    *   > [!IMPORTANT]
    > 所有配置路徑一律使用網路 UNC 格式（如 `\\192.168.1.99\...`），絕對避免使用 `Z:\` 等磁碟機代號，防止不同 Windows 登入工作階段對虛擬磁碟機的掛載隔離造成存取失敗。
4.  **建立根目錄**：
    *   在主機的 `C:\` 磁碟根目錄建立一個資料夾，命名為 `C:\agy_Add_on`。

---

## 📌 【第二階段：外掛程式下載與檔案佈置】
5.  **拉取程式碼**：
    *   在 `C:\agy_Add_on` 資料夾中以 PowerShell 執行：
        ```bash
        git clone [您的Git倉庫網址] ERP_System
        ```
    *   > [!CAUTION]
    > 若您的倉庫是私有倉庫，請使用 SSH Key 驗證，或設定 `git config --global credential.helper store`。嚴禁直接使用 `git clone https://<token>@github.com/...` 的內嵌 Token 指令，防止敏感憑證以明文儲存在本機 `.git/config` 檔中。
6.  **佈置啟動指令檔**：
    *   將 `C:\agy_Add_on\ERP_System` 資料夾底下的：
        *   `win_service_monitor.vbs`
        *   `run_query.bat`
    *   這兩個檔案複製一份，貼到父目錄 `C:\agy_Add_on\` 下。
    *   > [!NOTE]
    > **零套件依賴 (Zero Dependency) 提示：**
    > 本系統在開發設計上採取「零依賴套件」原則，皆使用 Node.js 內建核心模組，故複製代碼後**無需**執行 `npm install`。

---

## 📌 【第三階段：雲端 Google Apps Script Webhook 部署】
7.  **建立雲端登記表**：
    *   在 Google 雲端硬碟建立「欠貨未出貨登記表」試算表。
8.  **部署 Apps Script**：
    *   點選「擴充功能」➔「Apps Script」，貼入雲端同步代碼，儲存並發佈為「網頁應用程式」。
    *   權限設定為「任何人 (Anyone)」，複製產生的網頁應用程式網址 (Webhook URL)。

---

## 📌 【第四階段：外掛系統基本設定與初始安全掩護】
9.  **開啟管理後台**：
    *   進入 `C:\agy_Add_on\ERP_System`，在背景手動啟動 `node take_server.js`，或直接編輯 `config.json`。
    *   在瀏覽器開啟 `http://localhost:3000/config` 管理後台網頁。
10. **填寫與儲存設定**：
    *   **資料庫路徑**：填入 `\\192.168.1.99\d\nmedi\stock.DBF`。
    *   **欠貨 Webhook 網址**：貼上剛剛在 Google 取得的 Webhook 網址。
    *   **機器人 Slots**：填入各機器人的 Telegram Token，並手動填入經過授權的 Chat IDs。
    *   點擊「儲存所有設定」。
11. **寫入初始避讓標記（關鍵隱蔽步驟）**：
    *   > [!IMPORTANT]
    > 在首次啟動主機 Bot 查價服務前，必須先在主機手動建立 `C:\agy_Add_on\maintenance_mode.txt`，並寫入 `remote` 字串。這可確保 Bot 在啟動的一瞬間就處於休眠避讓模式，封堵「系統商正好處於連線狀態、主機啟動瞬間暴露行為」的時間差漏洞 (Race Condition)。

---

## 📌 【第五階段：用戶分機 (Client PCs) 避讓雷達部署】
在其他 3 台辦公室分機電腦上執行：

12. **建立防禦目錄**：
    *   在分機的 `C:\` 底下建立 `C:\agy_Add_on` 資料夾。確保分機已取得 NAS `locks/` 目錄的讀寫權限。
13. **複製防禦程式**：
    *   將主機 `ERP_System` 裡的 `locks_radar.ps1` 與 `silent_run.vbs` 複製到分機的 `C:\agy_Add_on`。
14. **設定開機自啟動**：
    *   在分機按 `Win + R` 執行 `shell:startup` 打開開機啟動夾。
    *   將 `C:\agy_Add_on\silent_run.vbs` 的**捷徑**移入該資料夾內。
    *   在新分機上手動執行一次該捷徑，確認其會在 NAS 上即時寫入對應的 `.lock` 鎖定檔。

---

## 📌 【第六階段：自癒排程與背景服務啟動】
回到主機執行：

15. **部署守護工作排程**：
    *   > [!IMPORTANT]
    > 基於 Windows 安全隔離，`SYSTEM` 帳戶在新電腦上沒有存取 NAS 網路磁碟的認證權限。我們必須在主機以系統管理員身分開啟 PowerShell，使用原生 ScheduledTask 宣告來建立排程：
    ```powershell
    # 1. 定義執行動作：呼叫 WScript 執行守護腳本
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"C:\agy_Add_on\win_service_monitor.vbs`""
    
    # 2. 定義觸發器：在任何使用者登入時即在背景常駐執行
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    
    # 3. 指定執行身分為「互動登入者工作階段」，並賦予最高系統權限，以保證取得網路磁碟存取權
    $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\INTERACTIVE" -LogonType Interactive -RunLevel Highest
    
    # 4. 限制配置：防止重複實例，且執行若卡死超過 2 小時則自動終止
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances Ignore
    
    # 5. 註冊排程
    Register-ScheduledTask -TaskName "VFP_ERP_Service_Monitor" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force
    ```
16. **正式啟動外掛服務**：
    *   > [!NOTE]
    > `win_service_monitor.vbs` 與 `ERP_startup.vbs` 已在頂部新增代碼：自動切換 `CurrentDirectory` 至腳本所在目錄，徹底解決了 Windows 排程從 `System32` 起始執行導致的相對路徑找不到 bat 地雷。
    *   雙擊執行 `C:\agy_Add_on\ERP_startup.vbs`。這會重啟背景的所有常駐模組。
17. **解除初始避讓**：
    *   服務啟動完成後，將主機 `maintenance_mode.txt` 的內容修改回 `false`，即可讓外掛系統進入正式的自律運作。

---

## 📌 【第七階段：整套聯防功能與自癒測試】
18. **驗證查價與同步**：
    *   在手機 Telegram 上隨機進行查價、歷史成交價查詢以及未出貨查詢，確認各個授權機器人均能正常且流暢地在數秒內回傳資料。
19. **驗證避讓防禦**：
    *   在任一分機打開 AnyDesk 連線，確認 NAS `locks/` 產生鎖定檔，且主機 Bot 在 15 秒內進入「深層睡眠」（停止 Polling 且無任何 Consoles 殘留）。
    *   關閉 AnyDesk 後，確認 Bot 自動甦醒，恢復查價功能。
20. **清理 PowerShell 指令痕跡 (防窺探)**：
    *   安裝完成後，在新主機與分機的 PowerShell 中執行以下指令，清除 PSReadLine 的歷史指令紀錄：
    ```powershell
    Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue
    ```
