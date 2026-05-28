# VFP ERP Telegram Agent & Price/Stock Query Tool

⚠️ **Strictly Non-Commercial / Private Use Only (僅限個人及非商業用途)**

[繁體中文](#繁體中文) | [English](#english)

---

<a name="繁體中文"></a>
# 繁體中文說明

專為傳統 ERP（以 Visual FoxPro DBF 作為資料庫儲存）設計的智慧行動化升級外掛。整合了 Telegram 機器人對話查價與主力低庫存推播，提供高效、零侵入式且安全的行動作業方案。

## 🌟 核心功能

1. **客戶專屬歷史售價查詢 (History)**
   - 業務在機器人中輸入 `客戶關鍵字 商品關鍵字`（如：`大白 小太羊`），系統會在 200 毫秒內使用「逆向分塊緩衝讀取」技術檢索銷貨明細大檔 (`ougo1.dbf`)，快速回傳該客戶最近三次的成交價格、數量與日期（防報錯價）。
2. **商品價格與庫存隨身查 (Query)**
   - 支援中英數混合免空格智慧分詞與 AND 交集比對，內建異體同音字映射（如：溼↔濕、台 ↔ 臺、寸 ↔ 吋、尺 ↔ 呎），即使建檔字元不一致，也能精準搜尋。
3. **智慧斷貨與低存排程推播 (Push)**
   - 每日定時比對庫存快照 (`stock_snapshot.json`)。**僅在商品庫存「從大於 0 剛好變為 0 (斷貨)」的瞬間**發送警報，避免無效警報轟炸。
4. **本機設定後台與安全防護鎖 (Config)**
   - 提供直觀的 GUI 後台介面 (http://localhost:3000/config) 管理機器人權限、推播時間與列管主力商品。
   - **本地防護鎖**：後台路由與 API 僅限本機 IP（127.0.0.1）訪問，防範敏感 Token 外洩。

## ⚠️ 專案最高指導原則
* **核心 ERP 系統「唯讀」**：本外掛系統在讀取資料時均採唯讀方式，嚴禁直接寫入、修改、刪除或覆蓋 Z 槽原始 ERP 的任何常規資料表或核心系統檔案，確保 ERP 本體系統絕對安全與穩定。

## 🚀 快速開始

1. 將 `config.json.template` 複製並重新命名為 `config.json`。
2. 進入 `config.json` 填寫本機資料庫路徑、Telegram 機器人 Token、可存取的 Chat ID。
3. 執行服務：
   ```bash
   node telegram_bot.js # 啟動機器人查價與推播服務
   node take_server.js  # 啟動後台設定伺服器
   ```
4. 或雙擊桌面或 `C:\agy_Add_on` 下的 VBS 代理腳本以隱形（無黑色視窗）常駐背景運行。

## 📄 授權協議 (License)
本專案採用 **非商業用途專有授權 (Proprietary Non-Commercial License)**。
* 僅限於個人學習、學術研究或企業內部流程優化使用。
* **嚴禁任何個人或組織將本系統全部或部分代碼用於商業性營利、轉售、外包交付、或作為收費 SaaS 服務。** 詳細條款請參閱 [LICENSE](LICENSE) 檔案。

---

<a name="english"></a>
# English Description

A zero-intrusion, mobile price and stock query extension designed for legacy ERP systems utilizing Visual FoxPro (VFP) DBF databases. It seamlessly connects Telegram bots to provide field staff with high-performance, secure, and real-time query operations.

## 🌟 Key Features

1. **Customer-Specific Price History Lookup (History)**
   - Sales reps can type `[Customer Keyword] [Product Keyword]` in Telegram (e.g., `Sheep Pharmacy Tape`). The bot uses "reverse block-buffer chunk scanning" to query the large invoice detail database (`ougo1.dbf`) and return the last 3 transaction records (date, product, quantity, unit, price) in <200ms.
2. **Product Price & Stock Query (Query)**
   - Supports mixed English-Chinese-numeric parsing without spaces, AND-logic multi-keyword search, and automatic character mapping for Chinese homophones/variants (e.g., 溼↔濕, 台↔臺, 寸↔吋, 尺↔呎).
3. **Smart Out-of-Stock Alerts & Push (Push)**
   - Schedules daily inventory snapshot comparisons (`stock_snapshot.json`). **Only triggers an alert when stock drops from >0 to exactly 0 (out-of-stock)**, preventing notification fatigue.
4. **Visual Config Dashboard & Local Security Lock (Config)**
   - Features a GUI control panel (http://localhost:3000/config) to manage bot slots, scheduled push times, and priority tracked items.
   - **Local Lock**: The dashboard page and config API bind strictly to localhost (127.0.0.1) to prevent credential leakage.

## ⚠️ Core Integration Principles
* **Read-Only Core ERP**: All operational functions query regular ERP tables in read-only mode to guarantee primary database integrity and prevent any exclusive locking issues.

## 🚀 Quick Start

1. Copy `config.json.template` and rename it to `config.json`.
2. Edit `config.json` to define your VFP database path, Telegram Bot Token, and authorized Chat IDs.
3. Start the services:
   ```bash
   node telegram_bot.js # Start the Telegram Bot & Push Scheduler
   node take_server.js  # Start the Config Dashboard Server
   ```
4. Alternatively, use the VBS wrappers under `C:\agy_Add_on` to run them silently in the background.

## 📄 License
This project is licensed under a **Proprietary Non-Commercial License**.
* Restricted strictly to personal learning, educational study, or internal workflow optimization.
* **Commercial exploitation, resale, outsourcing delivery, or deployment as a commercial SaaS offering is strictly prohibited.** See the [LICENSE](LICENSE) file for details.
