# 中興醫療物流 V23 施工進度表 (全知視角絕對防禦版)

- `[ ]` Step 1: 啟動隨機迷彩偽裝（修改主機名稱為系統感隨機亂碼並重啟）
- `[ ]` Step 2: 關閉反向探索與共享（關閉網路發現與共用）
- `[ ]` Step 3: 建立五大戰區目錄與防毒排除（建立五大目錄，使用 icacls 撤銷 Everyone/Authenticated Users 權限，啟用 BitLocker 加密金鑰鎖 TPM，GPO 禁用韌體更新防無頭啟動鎖死，且以 PowerShell 將整個 D 槽與 Node 進程加入 Windows Defender Exclusions 排除名單）
- `[ ]` Step 4: 核心內核優化、時間同步、黑洞防線與 Tailscale 域名解衝突（設定網卡為公用網路，停用 LLMNR/mDNS，防火牆規則封鎖 192.168.1.0/24 入站與 ICMP，放行 Tailscale，啟用高效能電源計劃並關閉網卡節能休眠，鎖定 NTP 且防火牆放行 UDP 123 入站回應，啟用 Tailscale MagicDNS 將主機綁定專屬域名 ultra7.z-med.ts.net 徹底免疫子網路衝突）
- `[ ]` Step 5: 安裝大腦資料庫、WAL防爆與防篡改法律審計（安裝 PostgreSQL 至 D:\04，優化 postgresql.conf 限定 max_wal_size=1GB/min_wal_size=80MB，配置資料庫 Trigger 變更審計日誌）
- `[ ]` Step 6: 全天候物理隔離與無鎖視圖切換（實作 stock_a/b 與 stock 視圖切換，確保高頻查詢零鎖定秒回）
- `[ ]` Step 7: 同步管線、VSS陰影防鎖死、本地 GC 與 NAS 備份金庫（編寫排程，隨機挑選上班員工帳號登入、連線後執行 net use delete 清除 session、加入防禦性檔案大小/結構校驗、防範 0x5C 轉義，新增加密備份傳送至 Synology NAS_DS925，本地執行 GC 僅保留 7 天備份，在 Tailscale 控制台設定 Disable Key Expiry，且同步複製 stock.DBF 遇鎖定時啟用退避重試，若重試失敗則呼叫 Windows VSS 拍下唯讀陰影快照強行抽出）
- `[ ]` Step 8: 執行 VFP 轉碼與匯入 PoC（驗證 passset.DBF 轉入 PostgreSQL）
- `[ ]` Step 9: 掛載健康檢查與網卡就緒防禦（設計 /health 端點並執行 DB 查詢 SELECT 1，VBS 連續 3 次探測失敗才重啟進程，Node.js 啟動腳本延遲 10 秒以防網卡未就緒）
- `[ ]` Step 10: 對接測試機器人 Bot 5（部署 Bot 5 至沙盒區 Port 3001）
- `[ ]` Step 11: 移轉前線打仗機器人 (Bot 1~4) 冪等限流型（部署 Bot 1~4 至正式區 Port 3000，連線轉向 PostgreSQL，回覆訊息附帶快照時間戳記，提供「閃電同步」即時查價按鈕，API 整合冪等性去重建單，單據鎖定待審核，重印單據標記補印，Windows 註冊表中鎖定自訂中一刀 FormID 預設格式，且 Node.js Bot 底層引入 Token Bucket Queue 限流隊列防止 Telegram 429 限流）
- `[ ]` Step 12: 刻畫星艦級雙視窗 IDE（建置沙盒區左 Gemini 右 Antigravity Agent IDE 的雙視窗開發介面）
