const http = require('http');
const fs = require('path');
const fsExtra = require('fs');

// 1. 載入設定檔以獲取 Token 與 DBF 路徑
const configPath = fs.join(__dirname, 'config.json');
let apiToken = '';
try {
    if (fsExtra.existsSync(configPath)) {
        const cfg = JSON.parse(fsExtra.readFileSync(configPath, 'utf8'));
        apiToken = cfg.apiToken || '';
        console.log(`[壓測] 成功載入 config.json，Token: ${apiToken ? '***已隱藏***' : '無'}`);
    }
} catch (e) {
    console.error('[壓測] 載入 config.json 失敗:', e.message);
}

const PORT = 3000;
const HOST = '127.0.0.1';

// 輔助函式：發送 HTTP 請求
function sendRequest(method, path, payload = null) {
    return new Promise((resolve) => {
        const start = Date.now();
        const dataStr = payload ? JSON.stringify(payload) : null;
        
        const options = {
            hostname: HOST,
            port: PORT,
            path: path,
            method: method,
            headers: {
                'x-api-token': apiToken
            }
        };

        if (dataStr) {
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(dataStr);
        }

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const duration = Date.now() - start;
                resolve({
                    success: res.statusCode >= 200 && res.statusCode < 300,
                    statusCode: res.statusCode,
                    duration,
                    body: body.substring(0, 100) // 僅取前100字
                });
            });
        });

        req.on('error', (e) => {
            resolve({
                success: false,
                statusCode: 0,
                duration: Date.now() - start,
                error: e.message
            });
        });

        req.setTimeout(30000, () => {
            req.destroy();
            resolve({
                success: false,
                statusCode: 504,
                duration: Date.now() - start,
                error: 'Timeout'
            });
        });

        if (dataStr) {
            req.write(dataStr);
        }
        req.end();
    });
}

// 統計並報告測試結果
function reportResults(name, results) {
    const total = results.length;
    const successes = results.filter(r => r.success).length;
    const failures = total - successes;
    const durations = results.map(r => r.duration);
    const avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / total);
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);
    
    console.log(`\n=================== 【${name}】 ===================`);
    console.log(`總請求數: ${total}`);
    console.log(`成功: ${successes} | 失敗: ${failures} (成功率: ${((successes/total)*100).toFixed(1)}%)`);
    console.log(`平均延遲: ${avgDuration} ms`);
    console.log(`最小延遲: ${minDuration} ms | 最大延遲: ${maxDuration} ms`);
    
    // 若有失敗，印出前幾筆錯誤
    const failedSamples = results.filter(r => !r.success).slice(0, 3);
    if (failedSamples.length > 0) {
        console.log(`錯誤樣本:`);
        failedSamples.forEach(f => {
            console.log(`  - 狀態碼: ${f.statusCode} | 延遲: ${f.duration}ms | 錯誤/內容: ${f.error || f.body}`);
        });
    }
    return { name, total, successes, failures, avgDuration, maxDuration, minDuration };
}

// 模擬盤點資料
const mockInventoryData = {
    date: new Date().toISOString().slice(0,10).replace(/-/g,''),
    time: new Date().toTimeString().slice(0,8).replace(/:/g,''),
    items: [
        {
            mno: "STRESSTEST",
            bno: "STRESSTEST",
            sno: "STRESSTEST",
            mname: "壓力測試商品",
            scal: 1,
            q1: 0,
            q0: 10,
            qut: 10,
            unit: "個",
            units: "個",
            pupri: 100
        }
    ]
};

async function runAllTests() {
    console.log('[壓測] 開始執行壓力測試流程...');
    const startTime = Date.now();
    const summary = [];

    // --- 測試 1：並發商品精確查詢 (q=酒精) ---
    console.log('\n[步驟 1] 模擬 20 個並發查詢「酒精」商品...');
    const queryPromises = [];
    for (let i = 0; i < 20; i++) {
        queryPromises.push(sendRequest('GET', `/api/products?q=%E9%85%92%E7%B2%BE`));
    }
    const queryResults = await Promise.all(queryPromises);
    summary.push(reportResults('商品查詢並發測試', queryResults));

    // --- 測試 2：並發模糊商品查詢 (q=3m) ---
    console.log('\n[步驟 2] 模擬 20 個並發查詢模糊關鍵字「3m」...');
    const fuzzyPromises = [];
    for (let i = 0; i < 20; i++) {
        fuzzyPromises.push(sendRequest('GET', `/api/products?q=3m`));
    }
    const fuzzyResults = await Promise.all(fuzzyPromises);
    summary.push(reportResults('模糊查詢並發測試', fuzzyResults));

    // --- 測試 3：並發庫存預測計算 (api/forecast) ---
    console.log('\n[步驟 3] 模擬 5 個用戶同時點擊庫存預測儀表板...');
    const forecastPromises = [];
    for (let i = 0; i < 5; i++) {
        forecastPromises.push(sendRequest('GET', `/api/forecast`));
    }
    const forecastResults = await Promise.all(forecastPromises);
    summary.push(reportResults('庫存預測 API 並發測試', forecastResults));

    // --- 測試 4：並發盤點上傳 (POST api/upload) ---
    console.log('\n[步驟 4] 模擬 5 位倉管人員同時上傳盤點明細 (PS 寫入 DBF)...');
    const uploadPromises = [];
    for (let i = 0; i < 5; i++) {
        uploadPromises.push(sendRequest('POST', `/api/upload`, mockInventoryData));
    }
    const uploadResults = await Promise.all(uploadPromises);
    summary.push(reportResults('盤點上傳並發測試', uploadResults));

    // --- 測試 5：防刷防洪測試 ---
    console.log('\n[步驟 5] 模擬 1 位同仁以超高頻率（無間隔）連點 10 次商品查詢...');
    const floodPromises = [];
    for (let i = 0; i < 10; i++) {
        floodPromises.push(sendRequest('GET', `/api/products?q=%E9%85%92%E7%B2%BE`));
    }
    const floodResults = await Promise.all(floodPromises);
    summary.push(reportResults('API 連點防刷測試', floodResults));

    console.log(`\n[壓測] 全部測試執行完畢，總耗時: ${Date.now() - startTime} ms`);
    return summary;
}

// 支援命令列執行
if (require.main === module) {
    runAllTests().catch(err => console.error('[壓測] 執行異常:', err));
}

module.exports = { runAllTests };
