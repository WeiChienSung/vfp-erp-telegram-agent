/**
 * ERP 隨身查 - 庫存歸零即時告警核心引擎
 * 模組路徑：C:\agy_Add_on\ERP_System\zero_stock_alert.js
 */
const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, 'stock_snapshot.json');

/**
 * 載入庫存快照 (首啟防護邏輯)
 * @param {Array} currentRecords 目前 ERP 資料庫中的所有商品紀錄
 * @returns {Object} 庫存快照對象
 */
function loadStockSnapshot(currentRecords) {
    try {
        if (fs.existsSync(SNAPSHOT_PATH)) {
            const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('[快照模組] 載入快照失敗，重新重建:', e.message);
    }
    
    // 檔案不存在或解析失敗 ➔ 建立初始快照，本次輪詢靜默不推播
    const initial = {};
    for (const r of currentRecords) {
        if (r.NO) {
            initial[r.NO] = r.INVQT !== undefined ? r.INVQT : 0;
        }
    }
    saveStockSnapshot(initial);
    console.log(`[快照模組] 初始快照已安全建立，共計 ${currentRecords.length} 筆商品。本次不觸發推播。`);
    return initial;
}

/**
 * 安全保存庫存快照至檔案 (原子寫入 Write-then-Rename)
 * @param {Object} snapshot 最新庫存快照
 */
function saveStockSnapshot(snapshot) {
    try {
        const tempPath = SNAPSHOT_PATH + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');
        fs.renameSync(tempPath, SNAPSHOT_PATH);
    } catch (e) {
        console.error('[快照模組] 儲存快照失敗:', e.message);
    }
}

/**
 * 核心變動比對狀態機
 * @param {Array} currentRecords 當前商品庫存記錄
 * @param {Object} config 系統設定檔
 * @returns {Object} 包含已售罄及主力低庫存商品列表
 */
function detectStockChanges(currentRecords, config) {
    const snapshot = loadStockSnapshot(currentRecords);
    const threshold = config.lowStockThreshold || 5;
    const priorityList = config.priorityProducts || [];
    
    const outOfStockAlerts = [];
    const lowStockAlerts = [];
    
    for (const product of currentRecords) {
        if (!product.NO) continue;
        
        // 物理過濾：已停用/停售、贈品、樣品、舊版、測試商品
        if (product._isStopped) continue;
        const name = product.NAME || '';
        if (/贈品|樣品|舊版|測試|停用/.test(name)) continue;
        
        const prev = snapshot[product.NO];
        const curr = product.INVQT;
        
        // 避開沒有初始快照的新商品
        if (prev === undefined) {
            snapshot[product.NO] = curr;
            continue;
        }
        
        // 判定 1：一般商品售罄 (大於0變為小於等於0)
        if (prev > 0 && curr <= 0) {
            outOfStockAlerts.push(product);
        }
        // 判定 2：主力商品低庫存 (大於門檻變為小於等於門檻且大於0)
        else if (priorityList.includes(product.NO)) {
            if (prev > threshold && curr <= threshold && curr > 0) {
                lowStockAlerts.push(product);
            }
        }
        
        // 更新快照值
        snapshot[product.NO] = curr;
    }
    
    // 原子保存快照至硬碟
    saveStockSnapshot(snapshot);
    
    return { outOfStockAlerts, lowStockAlerts };
}

module.exports = {
    detectStockChanges
};
