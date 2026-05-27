// ERP 隨身助手 後台管理 JS (簡化版)

let localConfig = {
    databasePath: "",
    bots: []
};

// 初始化載入
document.addEventListener("DOMContentLoaded", () => {
    loadConfigFromServer();
});

// 從伺服器獲取設定檔
async function loadConfigFromServer() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('讀取設定檔失敗');
        
        localConfig = await response.json();
        
        // 確保核心結構完整
        if (!localConfig.bots) localConfig.bots = [];

        renderConfig();
    } catch (err) {
        showStatus(err.message, 'error');
    }
}

// 將設定數據渲染到畫面上
function renderConfig() {
    document.getElementById("databasePath").value = localConfig.databasePath || "";
    renderBots();
}

// ==================================================
// 機器人 slots 渲染與操作
// ==================================================

function renderBots() {
    const container = document.getElementById("botsContainer");
    container.innerHTML = "";

    if (localConfig.bots.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding: 2rem; color:var(--text-secondary);">目前尚未設定任何機器人，請點擊上方「新增機器人」按鈕。</div>`;
        return;
    }

    localConfig.bots.forEach((bot, bIndex) => {
        const card = document.createElement("div");
        card.className = "bot-card";
        
        // 判斷功能勾選狀態 (只保留 query 與 history，移除 take 與 push)
        const hasQuery = bot.features.includes("query") ? "checked" : "";
        const hasHistory = bot.features.includes("history") ? "checked" : "";

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
            chatBadges = `<div class="description" style="margin-bottom:0; font-size:0.8rem;">目前無授權聊天室，請在下方新增以獲得 Bot 授權。</div>`;
        }

        card.innerHTML = `
            <div class="bot-card-header">
                <div class="bot-title">🤖 機器人 Slot #${bIndex + 1}</div>
                <button type="button" class="btn-danger-text" onclick="deleteBotSlot(${bIndex})">刪除此機器人</button>
            </div>

            <div class="form-group">
                <label>自訂顯示名稱</label>
                <input type="text" value="${bot.name || ''}" onchange="updateBotField(${bIndex}, 'name', this.value)" placeholder="例如: 查價主機器人">
            </div>

            <div class="form-group">
                <label>Telegram Bot Token</label>
                <input type="text" value="${bot.token || ''}" onchange="updateBotField(${bIndex}, 'token', this.value)" placeholder="請輸入 Bot Token">
            </div>

            <div class="form-group">
                <label>啟用功能選單</label>
                <div class="bot-features">
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasQuery} onchange="toggleBotFeature(${bIndex}, 'query', this.checked)"> 商品查價 (Query)
                    </label>
                    <label class="checkbox-container">
                        <input type="checkbox" ${hasHistory} onchange="toggleBotFeature(${bIndex}, 'history', this.checked)"> 歷史成交查詢 (History)
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
        features: ["query", "history"],
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
// 確保當使用者貼上含有空白的 Token 時自動修剪
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

    if (!path) {
        showStatus('資料庫路徑不可為空', 'error');
        return;
    }

    localConfig.databasePath = path;

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
