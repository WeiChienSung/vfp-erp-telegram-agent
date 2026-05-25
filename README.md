# VFP ERP Telegram Agent & Mobile Stocktake Tool

專為傳統 ERP (Visual FoxPro DBF 資料庫) 設計的行動化升級外掛。打通 Telegram 機器人與手機網頁，提供高效且零侵入式的行動辦公方案。

## 🌟 核心功能
* **客戶專屬歷史售價查詢 (History)**：業務在對話中輸入「客戶 商品」關鍵字，系統在 200 毫秒內逆向檢索銷貨明細大檔，顯示該客戶最近三次的成交價格、數量與日期（防報錯價）。
* **商品價格與庫存查詢 (Query)**：支援繁簡中文同音異體字自動相容 (如：溼↔濕)，品牌拆詞搜尋。
* **行動條碼掃描盤點助手 (Take)**：手機網頁直接呼叫鏡頭掃描條碼，支援廠商過濾與離線快取暫存，數據直寫 ERP。
* **智慧斷貨與低存排程推播 (Push)**：狀態快照比對，僅在商品庫存剛歸零的瞬間發送通知，防訊息爆量。

## 🛡️ 安全防護
* **本機設定限制**：管理後台僅限主機本機 (localhost / lvh.me) 存取。
* **外網 API 安全鎖**：外部 API 請求強制校驗動態產生的 `apiToken` 安全金鑰。

---

## 🚀 快速開始
1. 將 `config.json.template` 複製並重新命名為 `config.json`。
2. 修改 `config.json` 中的資料庫路徑、Telegram Bot Token 及安全驗證金鑰。
3. 執行 `node telegram_bot.js` (查價與推播) 和 `node take_server.js` (盤點與設定後台)。
