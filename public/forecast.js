/* forecast.js — 庫存預測儀表板前端邏輯 */
'use strict';

let allItems = [];
let forecastMeta = {};
let currentFilter = 'urgent';
let currentSort   = { col: 'daysLeft', asc: true };
let prioritySet   = new Set();

// 從 URL 或 localStorage 獲取安全金鑰 (Token)，並包含淨化與持久化
function getToken() {
    const p = new URLSearchParams(window.location.search);
    const urlToken = p.get('token');
    
    if (urlToken) {
        // 防呆淨化過濾：如果不含非法字元，則寫入 localStorage
        if (!urlToken.includes('/') && !urlToken.includes('?') && urlToken.length <= 50) {
            localStorage.setItem('api_token', urlToken);
        }
        // 清除網址列上的 token 參數以策安全
        try {
            window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) {}
        return urlToken;
    }
    
    // 嘗試從 localStorage 獲取
    const cachedToken = localStorage.getItem('api_token') || '';
    if (cachedToken && !cachedToken.includes('/') && !cachedToken.includes('?') && cachedToken.length <= 50) {
        return cachedToken;
    }
    
    return '';
}

/* ─────────────────────────────────────
   資料載入
───────────────────────────────────── */
async function loadForecast() {
    showLoading();
    document.getElementById('btnExport').disabled = true;
    document.getElementById('headerSub').textContent = '正在計算 2 年銷售紀錄...';

    try {
        const token = getToken();
        const qs = token ? `?token=${encodeURIComponent(token)}` : '';
        const res = await fetch(`/api/forecast${qs}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || res.statusText);
        }
        const data = await res.json();
        
        // 如果伺服器回傳正在背景計算快取中，則在 3 秒後自動輪詢重試
        if (data.loading) {
            document.getElementById('headerSub').textContent = data.message || '資料正在背景計算中，請稍候...';
            setTimeout(loadForecast, 3000);
            return;
        }
        
        allItems     = data.items || [];
        forecastMeta = data.meta  || {};
        prioritySet  = new Set((forecastMeta.priorityProducts || []).map(x => String(x).toLowerCase()));

        updateStatCards();
        applyFilters();
        document.getElementById('btnExport').disabled = false;

        const ts = new Date().toLocaleTimeString('zh-TW');
        document.getElementById('headerSub').textContent =
            `共 ${forecastMeta.totalActive} 項活躍商品 ｜ 補貨週期 ${forecastMeta.leadDays} 工作天 ｜ 更新：${ts}`;

        updateSummaryHint();
    } catch (e) {
        showEmpty(`載入失敗：${e.message}`);
        document.getElementById('headerSub').textContent = '載入失敗，請重新整理';
    }
}

function updateSummaryHint() {
    const el = document.getElementById('hintUrgent');
    if (el && forecastMeta.leadDays) {
        el.textContent = `不足 ${forecastMeta.leadDays} 工作天存量`;
    }
}

/* ─────────────────────────────────────
   統計卡片
───────────────────────────────────── */
function updateStatCards() {
    const urgent  = allItems.filter(i => i.level === 'urgent').length;
    const watch   = allItems.filter(i => i.level === 'watch').length;
    const healthy = allItems.filter(i => i.level === 'healthy').length;

    document.getElementById('numUrgent').textContent  = urgent;
    document.getElementById('numWatch').textContent   = watch;
    document.getElementById('numHealthy').textContent = healthy;
    document.getElementById('numTotal').textContent   = allItems.length;
}

function setFilter(f) {
    currentFilter = f;
    document.querySelectorAll('.stat-card').forEach(el => el.classList.remove('active'));
    const map = { urgent: 'cardUrgent', watch: 'cardWatch', healthy: 'cardHealthy', all: 'cardAll' };
    if (map[f]) document.getElementById(map[f]).classList.add('active');
    applyFilters();
}

/* ─────────────────────────────────────
   搜尋 + 篩選 + 排序
───────────────────────────────────── */
function applyFilters() {
    const query       = document.getElementById('searchInput').value.trim().toLowerCase();
    const priorityOnly = document.getElementById('priorityOnly').checked;
    const clearBtn    = document.getElementById('searchClear');
    clearBtn.style.display = query ? 'block' : 'none';

    let filtered = allItems;

    // 狀態篩選
    if (currentFilter !== 'all') {
        filtered = filtered.filter(i => i.level === currentFilter);
    }

    // 搜尋篩選
    if (query) {
        filtered = filtered.filter(i =>
            (i.name  || '').toLowerCase().includes(query) ||
            (i.no    || '').toLowerCase().includes(query) ||
            (i.bno   || '').toLowerCase().includes(query)
        );
    }

    // 主力商品篩選
    if (priorityOnly) {
        filtered = filtered.filter(i => prioritySet.has((i.no || '').toLowerCase()));
    }

    // 排序
    filtered = sortItems(filtered);

    renderTable(filtered);

    const label = currentFilter === 'all' ? '全部' :
                  currentFilter === 'urgent' ? '🔴 緊急' :
                  currentFilter === 'watch'  ? '🟡 關注' : '🟢 充裕';
    document.getElementById('footerInfo').textContent =
        `顯示 ${filtered.length} 筆（篩選條件：${label}${query ? ' + 搜尋「' + query + '」' : ''}${priorityOnly ? ' + 主力商品' : ''}）`;
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    applyFilters();
}

/* ─────────────────────────────────────
   排序
───────────────────────────────────── */
function sortBy(col) {
    if (currentSort.col === col) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort = { col, asc: true };
    }
    document.querySelectorAll('.sort-arrow').forEach(el => {
        el.classList.remove('active');
        el.textContent = '↕';
    });
    const arrow = document.querySelector(`.sort-arrow[data-col="${col}"]`);
    if (arrow) {
        arrow.classList.add('active');
        arrow.textContent = currentSort.asc ? '↑' : '↓';
    }
    applyFilters();
}

function sortItems(list) {
    const { col, asc } = currentSort;
    return [...list].sort((a, b) => {
        let va, vb;
        if (col === 'level') {
            const order = { urgent: 0, watch: 1, healthy: 2 };
            va = order[a.level] ?? 3;
            vb = order[b.level] ?? 3;
        } else if (col === 'name') {
            va = (a.name || '').toLowerCase();
            vb = (b.name || '').toLowerCase();
        } else if (col === 'stock') {
            va = a.stock ?? 0;
            vb = b.stock ?? 0;
        } else if (col === 'avgMonthly') {
            va = a.avgMonthly ?? 0;
            vb = b.avgMonthly ?? 0;
        } else if (col === 'daysLeft') {
            va = a.daysLeft !== null ? a.daysLeft : 99999;
            vb = b.daysLeft !== null ? b.daysLeft : 99999;
        } else {
            va = 0; vb = 0;
        }
        if (va < vb) return asc ? -1 : 1;
        if (va > vb) return asc ? 1 : -1;
        return 0;
    });
}

/* ─────────────────────────────────────
   表格渲染
───────────────────────────────────── */
function renderTable(items) {
    hideLoading();
    const table = document.getElementById('dataTable');
    const empty = document.getElementById('emptyState');
    const tbody = document.getElementById('tableBody');

    if (items.length === 0) {
        table.style.display = 'none';
        empty.style.display = 'flex';
        empty.innerHTML = `<div class="empty-icon">🔍</div><p>目前沒有符合條件的商品</p>`;
        return;
    }
    empty.style.display = 'none';
    table.style.display = 'table';

    const leadDays = forecastMeta.leadDays || 7;

    tbody.innerHTML = items.map(item => {
        const isPriority = prioritySet.has((item.no || '').toLowerCase());
        const badgeCls  = item.level === 'urgent' ? 'badge-urgent' :
                          item.level === 'watch'  ? 'badge-watch'  : 'badge-healthy';
        const badgeTxt  = item.level === 'urgent' ? '🔴 緊急' :
                          item.level === 'watch'  ? '🟡 關注'  : '🟢 充裕';

        let daysHtml;
        if (item.daysLeft === null) {
            daysHtml = `<span class="days-none">無銷售紀錄</span>`;
        } else {
            const cls = item.daysLeft <= leadDays ? 'days-urgent' :
                        item.daysLeft <= 30       ? 'days-watch'  : 'days-healthy';
            daysHtml = `<span class="days-num ${cls}">${item.daysLeft}</span><span style="color:var(--text-muted);font-size:0.78rem">工作天</span>`;
        }

        const avgHtml = item.avgMonthly != null
            ? `${item.avgMonthly}<span style="color:var(--text-muted);font-size:0.78rem"> /月</span>`
            : `<span style="color:var(--text-muted)">—</span>`;

        return `<tr>
            <td><span class="badge ${badgeCls}">${badgeTxt}</span></td>
            <td><span class="product-name">${isPriority ? '<span class="priority-star">⭐</span>' : ''}${escHtml(item.name)}</span></td>
            <td><span class="product-no">${escHtml(item.no)}</span></td>
            <td style="text-align:right;font-weight:600;color:var(--text-primary)">${item.stock != null ? item.stock : '—'} <span style="color:var(--text-muted);font-size:0.78rem">${escHtml(item.unit||'')}</span></td>
            <td style="text-align:right">${avgHtml}</td>
            <td style="text-align:right;color:var(--text-muted)">${item.lowWater != null ? item.lowWater : '—'}</td>
            <td><div class="days-bar">${daysHtml}</div></td>
        </tr>`;
    }).join('');
}

/* ─────────────────────────────────────
   CSV 匯出
───────────────────────────────────── */
function exportCSV() {
    const query       = document.getElementById('searchInput').value.trim().toLowerCase();
    const priorityOnly = document.getElementById('priorityOnly').checked;

    let filtered = allItems;
    if (currentFilter !== 'all') filtered = filtered.filter(i => i.level === currentFilter);
    if (query)        filtered = filtered.filter(i => (i.name||'').toLowerCase().includes(query) || (i.no||'').toLowerCase().includes(query));
    if (priorityOnly) filtered = filtered.filter(i => prioritySet.has((i.no||'').toLowerCase()));
    filtered = sortItems(filtered);

    const headers = ['狀態', '品名', '品號', '庫存', '單位', '月均銷量', '低水位', '預估剩餘天數'];
    const rows = filtered.map(i => {
        const status = i.level === 'urgent' ? '緊急補貨' : i.level === 'watch' ? '建議關注' : '庫存充裕';
        const days   = i.daysLeft !== null ? i.daysLeft : '無銷售紀錄';
        return [status, i.name, i.no, i.stock ?? '', i.unit ?? '', i.avgMonthly ?? '', i.lowWater ?? '', days];
    });

    const bom = '\uFEFF';
    const csv = bom + [headers, ...rows].map(row =>
        row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    ).join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `庫存預測_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
}

/* ─────────────────────────────────────
   UI 狀態工具
───────────────────────────────────── */
function showLoading() {
    document.getElementById('loadingState').style.display = 'flex';
    document.getElementById('emptyState').style.display   = 'none';
    document.getElementById('dataTable').style.display    = 'none';
}
function hideLoading() {
    document.getElementById('loadingState').style.display = 'none';
}
function showEmpty(msg) {
    hideLoading();
    document.getElementById('dataTable').style.display  = 'none';
    const el = document.getElementById('emptyState');
    el.style.display = 'flex';
    el.innerHTML = `<div class="empty-icon">⚠️</div><p>${escHtml(msg)}</p>`;
}
function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────────────────────────────────
   啟動
───────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
    setFilter('urgent');
    loadForecast();
});
