# VFP ERP Telegram Agent & Mobile Stocktake Tool

專為傳統 ERP (Visual FoxPro DBF 資料庫) 設計的行動化升級外掛。打通 Telegram 機器人與手機網頁，提供高效且零侵入式的行動辦公方案。

## 🌟 核心功能
* **客戶專屬歷史售價查詢 (History)**：業務在對話中輸入「客戶 商品」關鍵字，系統在 200 毫秒內逆向檢索銷貨明細大檔，顯示該客戶最近三次的成交價格、數量與日期（防報錯價）。
* **商品價格與庫存查詢 (Query)**：支援繁簡中文同音異體字自動相容 (如：溼↔濕)，品牌拆詞搜尋。
* **行動條碼掃描盤點助手 (Take)**：手機網頁直接呼叫鏡頭掃描條碼，支援廠商過濾與離線快取暫存，數據直寫 ERP。


## 🛡️ 安全防護
* **本機設定限制**：管理後台僅限主機本機 (localhost / lvh.me) 存取。
* **外網 API 安全鎖**：外部 API 請求強制校驗動態產生的 `apiToken` 安全金鑰。

## ⚠️ 專案最高指導原則
* **「唯讀」核心 ERP 系統**：本外掛系統僅能對 ERP 資料庫 (DBF) 檔案進行資料查詢與快取。
* **嚴禁寫入 Z 槽原始 ERP 系統**：盤點結果僅能寫入特定的盤點暫存資料檔（如 `take.dbf` 及 `take1.dbf`），**嚴禁且絕對不可寫入、修改、刪除或覆蓋 Z 硬碟（ZRP 系統）中的任何常規 ERP 資料表或核心系統檔案**，以確保 ERP 本體系統的資料安全與運作穩定性。

## 🚀 快速開始
1. 將 `config.json.template` 複製並重新命名為 `config.json`。
2. 修改 `config.json` 中的資料庫路徑、Telegram Bot Token 及安全驗證金鑰。
3. 執行 `node telegram_bot.js` (核心查價服務) 和 `node take_server.js` (盤點與設定後台)。
