// ERP 隨身助手 後台管理 JS

let localConfig = {
    databasePath: "",
    lowStockThreshold: 5,
    pushTimes: [],
    priorityProducts: [],
    bots: []
};

// 儲存列管主力商品對照 (用於顯示搜尋結果與清單)
let priorityProductsDetails = [];
let searchResultsCache = [];

// 初始化載入
document.addEventListener("DOMContentLoaded", () => {
    // 滑桿數值顯示連動
    const slider = document.getElementById("lowStockThreshold");
    const valDisplay = document.getElementById("lowStockValue");
    slider.addEventListener("input", (e) => {
        valDisplay.textContent = e.target.value;
    });

    loadConfigFromServer();
});

// 從伺服器獲取設定檔
async function loadConfigFromServer() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('讀取設定檔失敗');
        
        localConfig = await response.json();
        
        // 確保核心結構完整
        if (!localConfig.pushTimes) localConfig.pushTimes = [];
        if (!localConfig.priorityProducts) localConfig.priorityProducts = [];
        if (!localConfig.bots) localConfig.bots = [];

        renderConfig();
        loadPriorityProductsDetails();
    } catch (err) {
        showStatus(err.message, 'error');
    }
}

// 將設定數據渲染到畫面上
function renderConfig() {
    document.getElementById("databasePath").value = localConfig.databasePath || "";
    document.getElementById("lowStockThreshold").value = localConfig.lowStockThreshold || 5;
    document.getElementById("lowStockValue").textContent = localConfig.lowStockThreshold || 5;

    renderPushTimes();
    renderBots();
}

// 渲染定時推播時間標籤
function renderPushTimes() {
    const list = document.getElementById("pushTimesList");
    list.innerHTML = "";

    localConfig.pushTimes.sort().forEach((time, index) => {
        const badge = document.createElement("div");
        badge.className = "time-badge";
        badge.innerHTML = `
            <span>${time}</span>
            <span class="remove-btn" onclick="removePushTime(${index})">×</span>
        `;
        list.appendChild(badge);
    });
}

// 新增定時推播時間
function addPushTime() {
    const input = document.getElementById("newPushTime");
    const time = input.value;
    if (!time) return;

    if (localConfig.pushTimes.includes(time)) {
        showStatus('該推播時間已存在', 'error');
        return;
    }

    localConfig.pushTimes.push(time);
    renderPushTimes();
    input.value = "";
}

// 移除定時推播時間
function removePushTime(index) {
    localConfig.pushTimes.splice(index, 1);
    renderPushTimes();
}

// 載入主力商品清單的中文名稱資訊
async function loadPriorityProductsDetails() {
    if (localConfig.priorityProducts.length === 0) {
        priorityProductsDetails = [];
        renderPriorityProducts();
        return;
    }

    try {
        const list = document.getElementById("priorityProductsList");
        list.innerHTML = `<div class="description">正在載入主力商品資訊...</div>`;

        const response = await fetch(`/api/products?nos=${encodeURIComponent(localConfig.priorityProducts.join(','))}`);
        if (response.ok) {
            priorityProductsDetails = await response.json();
            
            // 如果有些列管商品沒在簡易查詢中查到，保留代碼編號即可
            localConfig.priorityProducts.forEach(no => {
                if (!priorityProductsDetails.some(p => p.NO === no)) {
                    priorityProductsDetails.push({ NO: no, NAME: "主力列管商品", UNIT: "個", INVQT: 0 });
                }
            });
        }
        renderPriorityProducts();
    } catch (e) {
        console.error('載入主力商品詳情失敗:', e);
    }
}

// 渲染列管主力商品列表
function renderPriorityProducts() {
    const list = document.getElementById("priorityProductsList");
    list.innerHTML = "";
    document.getElementById("priorityCount").textContent = localConfig.priorityProducts.length;

    if (localConfig.priorityProducts.length === 0) {
        list.innerHTML = `<div class="description" style="text-align:center; padding: 1.5rem 0;">目前尚無設定主力商品，所有非斷貨商品皆不推播。</div>`;
        return;
    }

    // 依照 NO 去除重複
    const uniqueDetails = [];
    const seen = new Set();
    priorityProductsDetails.forEach(p => {
        if (!seen.has(p.NO) && localConfig.priorityProducts.includes(p.NO)) {
            seen.add(p.NO);
            uniqueDetails.push(p);
        }
    });

    uniqueDetails.forEach(p => {
        const item = document.createElement("div");
        item.className = "priority-item";
        item.innerHTML = `
            <div>
                <span class="priority-item-name">${p.NAME}</span>
                <span class="priority-item-meta">(${p.NO})</span>
            </div>
            <div>
                <span class="badge" style="background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); color: #34d399; margin-right: 1rem;">庫存: ${p.INVQT}</span>
                <button type="button" class="btn-danger-text" onclick="removePriorityProduct('${p.NO}')">移除</button>
            </div>
        `;
        list.appendChild(item);
    });
}

// 移除主力商品
function removePriorityProduct(no) {
    localConfig.priorityProducts = localConfig.priorityProducts.filter(id => id !== no);
    priorityProductsDetails = priorityProductsDetails.filter(p => p.NO !== no);
    renderPriorityProducts();
}

// 搜尋商品 (實時 API 搜尋)
async function searchProducts() {
    const input = document.getElementById("productSearchInput");
    const keyword = input.value.trim();
    if (!keyword) return;

    const resultsDiv = document.getElementById("searchResults");
    resultsDiv.innerHTML = `<div style="padding:1rem; text-align:center; font-size:0.85rem; color:var(--text-secondary);">正在搜尋中...</div>`;

    try {
        const response = await fetch(`/api/products?q=${encodeURIComponent(keyword)}`);
        if (!response.ok) throw new Error('搜尋失敗');
        
        const products = await response.json();
        searchResultsCache = products; // 暫存到全域變數，避免引號引發 HTML 屬性解析錯誤
        resultsDiv.innerHTML = "";

        if (products.length === 0) {
            resultsDiv.innerHTML = `<div style="padding:1rem; text-align:center; font-size:0.85rem; color:var(--text-secondary);">查無任何商品</div>`;
            return;
        }

        products.forEach(p => {
            const item = document.createElement("div");
            item.className = "search-item";
            
            const isAdded = localConfig.priorityProducts.includes(p.NO);
            const actionBtn = isAdded 
                ? `<span style="color:var(--accent-green); font-weight:bold;">已列管</span>`
                : `<button type="button" class="btn btn-secondary btn-small" onclick="addPriorityProduct('${p.NO}')">➕ 加入列管</button>`;

            item.innerHTML = `
                <div class="search-item-info">
                    <span class="search-item-no">${p.NO}</span>
                    <span>${p.NAME}</span>
                </div>
                <div>
                    ${actionBtn}
                </div>
            `;
            resultsDiv.appendChild(item);
        });
    } catch (err) {
        resultsDiv.innerHTML = `<div style="padding:1rem; text-align:center; font-size:0.85rem; color:var(--accent-red);">${err.message}</div>`;
    }
}

// 新增列管商品
function addPriorityProduct(no) {
    if (!localConfig.priorityProducts.includes(no)) {
        const p = searchResultsCache.find(prod => prod.NO === no);
        if (p) {
            localConfig.priorityProducts.push(no);
            priorityProductsDetails.push({ NO: p.NO, NAME: p.NAME, UNIT: p.UNIT, INVQT: p.INVQT });
            renderPriorityProducts();
            
            // 重新更新一下搜尋結果按鈕狀態
            searchProducts();
        }
    }
}

// ==================================================
// 機器人 slots 渲染與操作
// ==================================================

function renderBots() {
    const container = document.getElementById("botsContainer");
    container.innerHTML = "";

    if (localConfig.bots.length === 0) {
        container.innerHTML = `<div class="full-width" style="text-align:center; padding: 2rem; color:var(--text-secondary);">目前尚未設定任何機器人，請點擊上方「新增機器人」按鈕。</div>`;
        return;
    }

    localConfig.bots.forEach((bot, bIndex) => {
        const card = document.createElement("div");
        card.className = "bot-card";
        
        // 判斷功能勾選狀態
        const hasQuery = bot.features.includes("query") ? "checked" : "";
        const hasHistory = bot.features.includes("history") ? "checked" : "";
        const hasTake = bot.features.includes("take") ? "checked" : "";
        const hasPush = bot.features.includes("push") ? "checked" : "";

        // 渲染授權聊天室標籤
        let chatBadges = "";
        if (bot.authorizedChats && bot.authorizedChats.length > 0) {
            bot.authorizedChats.forEach((chatId, cIndex) => {
                chatBadges += `
                    <div class="chat-badge">
                        <span>${chatId}</span>
                        <span class="remove-chat" onclick="removeChatId(${bIndex}, ${cIndex})">×</span>
                    </div>
                `;
            });
        } else {
            chatBadges = `<div class="description" style="margin-bottom:0;">目前無授權聊天室，請在下方新增以接收推播或進行查詢。</div>`;
        }

        card.innerHTML = `
            <div class="bot-card-header">
                <div class="bot-title">🤖 機器人 Slots #${bIndex + 1}</div>
                <button type="button" class="btn-danger-text" onclick="deleteBotSlot(${bIndex})">刪除此機器人</button>
            </div>

            <div class="form-group">
                <label>自訂顯示名稱</label>
                <input type="text" value="${bot.name || ''}" onchange="updateBotField(${bIndex}, 'name', this.value)" placeholder="例如: 查價主機器人">
            </div>

            <div class="form-group">
                <label>Telegram Bot Token</label>
                <input type="text" value="${bot.token || ''}" onchange="updateBotField(${bIndex}, 'token', this.value)" placeholder="請輸入 45~50 位元的 Token">
            </div>

            <div class="form-group">
                <label>啟用功能選單</label>
                <div class="bot-features">
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasQuery} onchange="toggleBotFeature(${bIndex}, 'query', this.checked)"> 查價 (Query)
                    </label>
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasHistory} onchange="toggleBotFeature(${bIndex}, 'history', this.checked)"> 歷史售價 (History)
                    </label>
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasTake} onchange="toggleBotFeature(${bIndex}, 'take', this.checked)"> 盤點 (Take)
                    </label>
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasPush} onchange="toggleBotFeature(${bIndex}, 'push', this.checked)"> 庫存推播 (Push)
                    </label>
                </div>
            </div>

            <div class="bot-chats-section">
                <label>已授權的聊天室 ID (Authorized Chat IDs)</label>
                <div class="chat-badge-list">
                    ${chatBadges}
                </div>
                <div class="chat-input-bar">
                    <input type="text" id="newChatInput_${bIndex}" placeholder="例如: 5976208790">
                    <button type="button" class="btn btn-secondary btn-small" onclick="addChatId(${bIndex})">➕ 新增 ID</button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// 新增一個空白機器人槽位
function addBotSlot() {
    localConfig.bots.push({
        name: `BOT_${localConfig.bots.length + 1}`,
        token: "",
        features: ["query", "history", "take"],
        authorizedChats: []
    });
    renderBots();
}

// 刪除一個機器人槽位
function deleteBotSlot(index) {
    if (confirm(`確定要刪除第 ${index + 1} 個機器人配置嗎？`)) {
        localConfig.bots.splice(index, 1);
        renderBots();
    }
}

// 修改機器人屬性欄位
function updateBotField(bIndex, field, value) {
    localConfig.bots[bIndex][field] = value.trim();
}

// 切換機器人功能特徵
function toggleBotFeature(bIndex, feature, isChecked) {
    const features = localConfig.bots[bIndex].features;
    if (isChecked) {
        if (!features.includes(feature)) {
            features.push(feature);
        }
    } else {
        localConfig.bots[bIndex].features = features.filter(f => f !== feature);
    }
}

// 新增 Chat ID 到指定的機器人
function addChatId(bIndex) {
    const input = document.getElementById(`newChatInput_${bIndex}`);
    const val = input.value.trim();
    if (!val) return;

    const id = parseInt(val);
    if (isNaN(id)) {
        showStatus('Chat ID 格式錯誤 (必須是數字)', 'error');
        return;
    }

    if (!localConfig.bots[bIndex].authorizedChats) {
        localConfig.bots[bIndex].authorizedChats = [];
    }

    if (localConfig.bots[bIndex].authorizedChats.includes(id)) {
        showStatus('此 Chat ID 已經授權過囉！', 'error');
        return;
    }

    localConfig.bots[bIndex].authorizedChats.push(id);
    renderBots();
}

// 移除指定的 Chat ID
function removeChatId(bIndex, cIndex) {
    localConfig.bots[bIndex].authorizedChats.splice(cIndex, 1);
    renderBots();
}

// ==================================================
// 儲存設定到伺服器
// ==================================================

// 提示訊息顯示
function showStatus(msg, type = 'success') {
    const statusDiv = document.getElementById("saveStatus");
    statusDiv.textContent = msg;
    statusDiv.className = `status-msg status-${type}`;
    
    // 5秒後淡出
    setTimeout(() => {
        if (statusDiv.textContent === msg) {
            statusDiv.textContent = "";
        }
    }, 5000);
}

// 儲存設定
async function saveConfiguration() {
    const path = document.getElementById("databasePath").value.trim();
    const threshold = parseInt(document.getElementById("lowStockThreshold").value);

    if (!path) {
        showStatus('資料庫路徑不可為空', 'error');
        return;
    }

    localConfig.databasePath = path;
    localConfig.lowStockThreshold = threshold;

    // 驗證機器人 Token 填寫
    for (let i = 0; i < localConfig.bots.length; i++) {
        const bot = localConfig.bots[i];
        if (!bot.token) {
            showStatus(`機器人 Slot #${i + 1} (${bot.name}) 的 Token 未填寫`, 'error');
            return;
        }
    }

    showStatus('正在儲存設定...', 'success');

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(localConfig)
        });

        if (response.ok) {
            showStatus('💾 設定檔已成功儲存！所有常駐服務已即時加載套用！', 'success');
        } else {
            const errData = await response.json();
            throw new Error(errData.error || '儲存失敗');
        }
    } catch (err) {
        showStatus(`儲存失敗: ${err.message}`, 'error');
    }
}
