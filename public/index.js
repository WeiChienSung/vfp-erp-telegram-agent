// Main Mobile UI Logic for ERP_Take
document.addEventListener('DOMContentLoaded', () => {
    // 解析網址上的 token 金鑰並存入暫存 (改用 localStorage 以便在 Webview/重新整理時持久化)
    const urlParams = new URLSearchParams(window.location.search);
    let token = urlParams.get('token');
    if (token) {
        // 判斷是否為無效/被污染的拼接 Token (不應含斜線、問號、或過長)
        if (token.includes('/') || token.includes('?') || token.length > 50) {
            console.warn('[安全鎖] 偵測到被污染的無效 Token，拒絕寫入:', token);
            localStorage.removeItem('api_token');
        } else {
            localStorage.setItem('api_token', token);
            // 清除網址列上的 token 以免被截圖或看見
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }

    // 檢查現存的 localStorage 是否含有被污染的髒數據，有的話自動清除
    const cachedTokenOnLoad = localStorage.getItem('api_token') || '';
    if (cachedTokenOnLoad && (cachedTokenOnLoad.includes('/') || cachedTokenOnLoad.includes('?') || cachedTokenOnLoad.length > 50)) {
        console.warn('[安全鎖] 偵測到 localStorage 中有被污染的舊 Token，自動清除。');
        localStorage.removeItem('api_token');
    }

    // 封裝自帶 Token 驗證的 API 請求輔助函數
    function apiFetch(url, options = {}) {
        const cachedToken = localStorage.getItem('api_token') || '';
        if (!options.headers) {
            options.headers = {};
        }
        options.headers['x-api-token'] = cachedToken;
        return fetch(url, options);
    }

    // 檢查 API 響應，非 ok 時解析詳細錯誤訊息
    async function checkResponse(res) {
        if (res.ok) return res;
        
        let errorDetail = '';
        try {
            const data = await res.json();
            if (data && data.error) {
                errorDetail = data.error;
            }
        } catch (e) {
            try {
                const text = await res.text();
                if (text) errorDetail = text;
            } catch (e2) {}
        }
        
        let fullMsg = `HTTP ${res.status}`;
        if (errorDetail) {
            fullMsg += ` (${errorDetail})`;
        }
        
        if (res.status === 401) {
            fullMsg += '\n\n【提示】安全驗證金鑰已過期或不正確，請在 Telegram 隨身查 Bot 中輸入「盤點」以重新取得最新連結。';
        }
        
        throw new Error(fullMsg);
    }

    // State management
    let activeSupplier = null;
    let activeSupplierName = ''; // 用於比對目前選取的廠商名稱
    let suppliersList = []; // 存放所有向 API 獲取的廠商名單
    let productsList = []; // Products for the current supplier
    let draftCounts = {};  // Draft counts: { productNo: { q1, q0, qut, ... } }
    let activeProduct = null; // Product currently editing in modal
    let html5QrCode = null; // Scanner instance

    // Elements
    const supplierSearchInput = document.getElementById('supplier-search-input');
    const supplierDropdownList = document.getElementById('supplier-dropdown-list');
    const btnClearSupplierSearch = document.getElementById('btn-clear-supplier-search');
    const workspaceSection = document.getElementById('workspace-section');
    const searchInput = document.getElementById('search-input');
    const btnClearSearch = document.getElementById('btn-clear-search');
    const productListEl = document.getElementById('product-list');
    const draftCountEl = document.getElementById('draft-count');
    const scannedCountBadge = document.getElementById('scanned-count-badge');
    const appFooter = document.getElementById('app-footer');
    
    // Placeholder Elements
    const checklistLoading = document.getElementById('checklist-loading');
    const checklistEmpty = document.getElementById('checklist-empty');
    const checklistNoResults = document.getElementById('checklist-no-results');

    // Scanner Elements
    const btnToggleScanner = document.getElementById('btn-toggle-scanner');
    const btnCloseScanner = document.getElementById('btn-close-scanner');
    const scannerContainer = document.getElementById('scanner-container');

    // Quantity Modal Elements
    const quantityModal = document.getElementById('quantity-modal');
    const modalProductName = document.getElementById('modal-product-name');
    const modalProductCode = document.getElementById('modal-product-code');
    const modalShelfLocation = document.getElementById('modal-shelf-location');
    const modalSystemStock = document.getElementById('modal-system-stock');
    const modalScaleWrapper = document.getElementById('modal-scale-wrapper');
    const modalProductScale = document.getElementById('modal-product-scale');
    const labelQtyPrimary = document.getElementById('label-qty-primary');
    const inputQtyPrimary = document.getElementById('input-qty-primary');
    const secondaryInputGroup = document.getElementById('secondary-input-group');
    const labelQtySecondary = document.getElementById('label-qty-secondary');
    const inputQtySecondary = document.getElementById('input-qty-secondary');
    const btnCancelQty = document.getElementById('btn-cancel-qty');
    const btnConfirmQty = document.getElementById('btn-confirm-qty');

    // Force Add Elements
    const forceAddModal = document.getElementById('force-add-modal');
    const btnCloseForce = document.getElementById('btn-close-force');
    const forceSearchInput = document.getElementById('force-search-input');
    const forceSearchResults = document.getElementById('force-search-results');
    const forceLoading = document.getElementById('force-loading');

    // Footer actions
    const btnClearDraft = document.getElementById('btn-clear-draft');
    const btnUploadTake = document.getElementById('btn-upload-take');

    // Auth Elements
    const authModal = document.getElementById('auth-modal');
    const inputAuthToken = document.getElementById('input-auth-token');
    const btnSubmitAuth = document.getElementById('btn-submit-auth');
    const authErrorMsg = document.getElementById('auth-error-msg');

    // Lucide Icon Initializer
    lucide.createIcons();

    // 1. Initial Load: 檢查並載入
    initApp();

    function initApp() {
        const cachedToken = localStorage.getItem('api_token') || '';
        if (!cachedToken) {
            showAuthModal();
        } else {
            fetchSuppliers();
        }
    }

    function showAuthModal(isError = false) {
        authModal.classList.remove('hidden');
        if (isError) {
            authErrorMsg.classList.remove('hidden');
        } else {
            authErrorMsg.classList.add('hidden');
        }
        inputAuthToken.value = localStorage.getItem('api_token') || '';
        setTimeout(() => inputAuthToken.focus(), 150);
    }

    btnSubmitAuth.addEventListener('click', async () => {
        const inputVal = inputAuthToken.value.trim();
        if (!inputVal) {
            authErrorMsg.textContent = '⚠️ 請輸入安全金鑰';
            authErrorMsg.classList.remove('hidden');
            return;
        }

        btnSubmitAuth.disabled = true;
        const origText = btnSubmitAuth.innerHTML;
        btnSubmitAuth.textContent = '驗證中...';
        authErrorMsg.classList.add('hidden');

        localStorage.setItem('api_token', inputVal);

        try {
            const res = await apiFetch('/api/suppliers');
            await checkResponse(res);
            suppliersList = await res.json();
            
            renderSuppliersDropdown(suppliersList);
            authModal.classList.add('hidden');
        } catch (err) {
            authErrorMsg.textContent = err.message.includes('401') 
                ? '⚠️ 金鑰不正確，請重新輸入。' 
                : `⚠️ 連線錯誤: ${err.message}`;
            authErrorMsg.classList.remove('hidden');
        } finally {
            btnSubmitAuth.disabled = false;
            btnSubmitAuth.innerHTML = origText;
        }
    });

    inputAuthToken.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            btnSubmitAuth.click();
        }
    });

    async function fetchSuppliers() {
        try {
            const res = await apiFetch('/api/suppliers');
            await checkResponse(res);
            suppliersList = await res.json();
            
            // 渲染全體廠商名單到下拉選單
            renderSuppliersDropdown(suppliersList);
            authModal.classList.add('hidden');
        } catch (err) {
            if (err.message.includes('401')) {
                showAuthModal(true);
            } else {
                alert('載入廠商錯誤: ' + err.message);
            }
            supplierDropdownList.innerHTML = `<li class="dropdown-placeholder text-danger">載入失敗: ${err.message}</li>`;
        }
    }

    // 渲染廠商下拉清單
    function renderSuppliersDropdown(list) {
        supplierDropdownList.innerHTML = '';
        if (list.length === 0) {
            supplierDropdownList.innerHTML = '<li class="dropdown-placeholder">無符合的廠商</li>';
            return;
        }
        list.forEach(sup => {
            const li = document.createElement('li');
            const val = sup.code || sup.name;
            li.dataset.value = val;
            li.textContent = sup.name;
            if (activeSupplier === val) {
                li.classList.add('selected');
            }
            // 點擊廠商時選取
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                selectSupplier(sup);
            });
            supplierDropdownList.appendChild(li);
        });
    }

    // 篩選廠商清單
    function filterSuppliers(query) {
        const filtered = suppliersList.filter(sup => {
            const name = (sup.name || '').toLowerCase();
            const code = (sup.code || '').toLowerCase();
            return name.includes(query) || code.includes(query);
        });
        renderSuppliersDropdown(filtered);
    }

    // 選取廠商的動作
    async function selectSupplier(sup) {
        activeSupplier = sup.code || sup.name;
        activeSupplierName = sup.name;
        supplierSearchInput.value = sup.name;
        
        btnClearSupplierSearch.classList.remove('hidden');
        supplierDropdownList.classList.add('hidden');
        
        loadDraftFromLocalStorage();
        await loadProducts();
        workspaceSection.classList.remove('hidden');
        appFooter.classList.remove('hidden');
        updateFooterSummary();
        lucide.createIcons();
    }

    // 重設選取狀態
    function resetSupplierSelection() {
        activeSupplier = null;
        activeSupplierName = '';
        supplierSearchInput.value = '';
        btnClearSupplierSearch.classList.add('hidden');
        supplierDropdownList.classList.add('hidden');
        
        workspaceSection.classList.add('hidden');
        appFooter.classList.add('hidden');
        productListEl.innerHTML = '';
    }

    // 2. 廠商搜尋輸入欄位之 Event 監聽
    supplierSearchInput.addEventListener('click', (e) => {
        e.stopPropagation();
        supplierDropdownList.classList.remove('hidden');
        const query = supplierSearchInput.value.trim().toLowerCase();
        // 如果輸入框有字且不等於當前選取的廠商名，進行篩選；否則展示全部
        if (query && query !== activeSupplierName.toLowerCase()) {
            filterSuppliers(query);
        } else {
            renderSuppliersDropdown(suppliersList);
        }
    });

    supplierSearchInput.addEventListener('focus', () => {
        // 聚焦時自動選取全部文字，方便使用者直接打字替換
        supplierSearchInput.select();
    });

    supplierSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        supplierDropdownList.classList.remove('hidden');
        if (query) {
            btnClearSupplierSearch.classList.remove('hidden');
            filterSuppliers(query);
        } else {
            btnClearSupplierSearch.classList.add('hidden');
            renderSuppliersDropdown(suppliersList);
            resetSupplierSelection();
        }
    });

    // 清除廠商搜尋
    btnClearSupplierSearch.addEventListener('click', (e) => {
        e.stopPropagation();
        resetSupplierSelection();
        renderSuppliersDropdown(suppliersList);
    });

    // 點擊網頁其他地方時關閉下拉選單
    document.addEventListener('click', (e) => {
        if (!supplierSearchInput.contains(e.target) && !supplierDropdownList.contains(e.target)) {
            supplierDropdownList.classList.add('hidden');
        }
    });

    async function loadProducts() {
        checklistLoading.classList.remove('hidden');
        checklistEmpty.classList.add('hidden');
        checklistNoResults.classList.add('hidden');
        productListEl.innerHTML = '';
        
        try {
            const res = await apiFetch(`/api/products?supplier=${encodeURIComponent(activeSupplier)}`);
            await checkResponse(res);
            productsList = await res.json();
            
            checklistLoading.classList.add('hidden');
            if (productsList.length === 0) {
                checklistEmpty.classList.remove('hidden');
                return;
            }
            
            renderChecklist(productsList);
        } catch (err) {
            checklistLoading.classList.add('hidden');
            alert('載入商品失敗: ' + err.message);
        }
    }

    function renderChecklist(list) {
        productListEl.innerHTML = '';
        list.forEach(p => {
            const li = document.createElement('li');
            li.className = 'product-item';
            li.dataset.no = p.NO;
            
            // Check if draft exists
            const draft = draftCounts[p.NO];
            if (draft) {
                li.classList.add('counted');
            }

            const formattedStock = formatStockQty(p.INVQT, p.SCAL, p.UNIT, p.UNITS);
            const countDisplay = draft ? formatDraftQty(draft, p.UNIT, p.UNITS) : '未盤';

            li.innerHTML = `
                <div class="product-info">
                    <div class="product-name">${escapeHtml(p.NAME)}</div>
                    <div class="product-meta-row">
                        <span class="code-text">${escapeHtml(p.NO)}</span>
                        ${p.SNO ? `<span class="shelf-tag">儲位: ${escapeHtml(p.SNO)}</span>` : ''}
                        <span class="stock-tag">庫存: ${formattedStock}</span>
                    </div>
                </div>
                <div class="count-status">
                    <span class="qty-tag">${countDisplay}</span>
                </div>
            `;
            
            li.addEventListener('click', () => openQuantityModal(p));
            productListEl.appendChild(li);
        });
    }

    // Help format standard stock double quantities
    function formatStockQty(qty, scale, unit, units) {
        if (scale > 1 && units && units !== unit) {
            const boxes = Math.floor(qty / scale);
            const singles = Math.round(qty % scale);
            let str = '';
            if (boxes > 0) str += `${boxes}${unit}`;
            if (singles > 0 || boxes === 0) str += `${singles}${units}`;
            return str;
        }
        return `${qty} ${unit}`;
    }

    // Help format counted draft quantities
    function formatDraftQty(draft, unit, units) {
        if (draft.q1 > 0 && draft.q0 > 0) {
            return `${draft.q1}${unit} ${draft.q0}${units}`;
        } else if (draft.q1 > 0) {
            return `${draft.q1}${unit}`;
        } else if (draft.q0 > 0) {
            return `${draft.q0}${units}`;
        }
        return `${draft.qut}${units || unit}`;
    }

    // 3. Search and filter keyword implementation
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim().toLowerCase();
        if (query) {
            btnClearSearch.classList.remove('hidden');
        } else {
            btnClearSearch.classList.add('hidden');
        }
        
        filterProducts(query);
    });

    btnClearSearch.addEventListener('click', () => {
        searchInput.value = '';
        btnClearSearch.classList.add('hidden');
        filterProducts('');
    });

    function filterProducts(query) {
        if (!query) {
            renderChecklist(productsList);
            checklistNoResults.classList.add('hidden');
            return;
        }
        
        const filtered = productsList.filter(p => {
            const matchesNo = p.NO.toLowerCase().includes(query);
            const matchesName = p.NAME.toLowerCase().includes(query);
            const matchesBarcode = (p.BNO || '').toLowerCase().includes(query) || 
                                   (p.BNO1 || '').toLowerCase().includes(query);
            return matchesNo || matchesName || matchesBarcode;
        });

        renderChecklist(filtered);
        
        if (filtered.length === 0) {
            checklistNoResults.classList.remove('hidden');
        } else {
            checklistNoResults.classList.add('hidden');
        }
    }

    // 4. Quantity Modal implementation
    function openQuantityModal(product) {
        activeProduct = product;
        modalProductName.textContent = product.NAME;
        modalProductCode.textContent = product.NO;
        modalShelfLocation.textContent = product.SNO || '無';
        modalSystemStock.textContent = formatStockQty(product.INVQT, product.SCAL, product.UNIT, product.UNITS);

        // Reset inputs
        inputQtyPrimary.value = '';
        inputQtySecondary.value = '';

        const hasSecondary = product.SCAL > 1 && product.UNITS && product.UNITS !== product.UNIT;
        
        if (hasSecondary) {
            modalScaleWrapper.classList.remove('hidden');
            modalProductScale.textContent = `1${product.UNIT} = ${Math.floor(product.SCAL)}${product.UNITS}`;
            labelQtyPrimary.textContent = `盤點箱數 (${product.UNIT}):`;
            secondaryInputGroup.classList.remove('hidden');
            labelQtySecondary.textContent = `加零散個數 (${product.UNITS}):`;
        } else {
            modalScaleWrapper.classList.add('hidden');
            labelQtyPrimary.textContent = `盤點數量 (${product.UNIT}):`;
            secondaryInputGroup.classList.add('hidden');
        }

        // Fill existing draft if any
        const existing = draftCounts[product.NO];
        if (existing) {
            if (hasSecondary) {
                inputQtyPrimary.value = existing.q1 || '';
                inputQtySecondary.value = existing.q0 || '';
            } else {
                inputQtyPrimary.value = existing.qut || '';
            }
            // ⚠️ 重複掃描警示
            const prevQtyText = hasSecondary
                ? (existing.q1 || 0) + ' ' + product.UNIT + ' + ' + (existing.q0 || 0) + ' ' + (product.UNITS || '')
                : (existing.qut || 0) + ' ' + product.UNIT;
            const wb = document.getElementById('duplicateScanWarning');
            if (wb) { wb.textContent = '⚠️ 此商品上次已輸入：' + prevQtyText + '，確認艆要覆蓋？'; wb.classList.remove('hidden'); }
        } else {
            const wb = document.getElementById('duplicateScanWarning');
            if (wb) wb.classList.add('hidden');
        }

        quantityModal.classList.remove('hidden');
        inputQtyPrimary.focus();
    }

    btnCancelQty.addEventListener('click', () => {
        quantityModal.classList.add('hidden');
        activeProduct = null;
    });

    btnConfirmQty.addEventListener('click', () => {
        if (!activeProduct) return;

        const scale = activeProduct.SCAL || 1;
        const hasSecondary = scale > 1 && activeProduct.UNITS && activeProduct.UNITS !== activeProduct.UNIT;

        let q1 = parseFloat(inputQtyPrimary.value) || 0;
        let q0 = parseFloat(inputQtySecondary.value) || 0;

        if (q1 < 0) q1 = 0;
        if (q0 < 0) q0 = 0;

        let qut = 0;
        if (hasSecondary) {
            qut = (q1 * scale) + q0;
        } else {
            qut = q1;
        }

        if (qut === 0) {
            // Remove from draft
            delete draftCounts[activeProduct.NO];
        } else {
            draftCounts[activeProduct.NO] = {
                mno: activeProduct.NO,
                bno: activeProduct.BNO || '',
                sno: activeProduct.SNO || '',
                mname: activeProduct.NAME,
                scal: scale,
                q1: hasSecondary ? q1 : 0,
                q0: hasSecondary ? q0 : 0,
                qut: qut,
                unit: activeProduct.UNIT,
                units: activeProduct.UNITS || ''
            };
        }

        saveDraftToLocalStorage();
        updateFooterSummary();

        // Update list item visually
        const itemEl = document.querySelector(`.product-item[data-no="${activeProduct.NO}"]`);
        if (itemEl) {
            const countDisplay = draftCounts[activeProduct.NO] ? 
                formatDraftQty(draftCounts[activeProduct.NO], activeProduct.UNIT, activeProduct.UNITS) : '未盤';
            
            const qtyTag = itemEl.querySelector('.qty-tag');
            if (qtyTag) qtyTag.textContent = countDisplay;
            
            if (draftCounts[activeProduct.NO]) {
                itemEl.classList.add('counted');
            } else {
                itemEl.classList.remove('counted');
            }
        }

        quantityModal.classList.add('hidden');
        activeProduct = null;
    });

    // 5. Local Storage implementation
    function getLocalStorageKey() {
        return `erp_take_draft_${activeSupplier}`;
    }

    function saveDraftToLocalStorage() {
        if (!activeSupplier) return;
        localStorage.setItem(getLocalStorageKey(), JSON.stringify(draftCounts));
    }

    function loadDraftFromLocalStorage() {
        if (!activeSupplier) return;
        const raw = localStorage.getItem(getLocalStorageKey());
        draftCounts = raw ? JSON.parse(raw) : {};
    }

    function updateFooterSummary() {
        const count = Object.keys(draftCounts).length;
        draftCountEl.textContent = count;
        scannedCountBadge.textContent = `已盤點: ${count} 筆`;
    }

    // Number keyboard +/- adjustments
    document.querySelectorAll('.num-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const input = document.getElementById(targetId);
            let current = parseFloat(input.value) || 0;
            if (btn.classList.contains('btn-plus')) {
                input.value = current + 1;
            } else if (btn.classList.contains('btn-minus')) {
                input.value = Math.max(0, current - 1);
            }
        });
    });

    // 6. Camera Barcode Scanner implementation
    btnToggleScanner.addEventListener('click', () => {
        if (scannerContainer.classList.contains('hidden')) {
            startScanner();
        } else {
            stopScanner();
        }
    });

    btnCloseScanner.addEventListener('click', stopScanner);

    function startScanner() {
        scannerContainer.classList.remove('hidden');
        btnToggleScanner.innerHTML = '<i data-lucide="scan-face" class="btn-icon"></i><span>關閉條碼掃描</span>';
        lucide.createIcons();

        html5QrCode = new Html5Qrcode("reader");
        html5QrCode.start(
            { facingMode: "environment" },
            { fps: 10, qrbox: { width: 250, height: 180 } },
            onScanSuccess,
            onScanFailure
        ).catch(err => {
            alert("啟動相機失敗: " + err);
            stopScanner();
        });
    }

    function stopScanner() {
        if (html5QrCode) {
            html5QrCode.stop().then(() => {
                html5QrCode = null;
            }).catch(err => console.error("Error stopping scanner:", err));
        }
        scannerContainer.classList.add('hidden');
        btnToggleScanner.innerHTML = '<i data-lucide="aperture" class="btn-icon"></i><span>啟動條碼掃描</span>';
        lucide.createIcons();
    }

    async function onScanSuccess(decodedText) {
        // Success scan! Find the barcode
        stopScanner();
        
        try {
            const res = await apiFetch(`/api/scan?barcode=${encodeURIComponent(decodedText)}`);
            if (res.status === 404) {
                // Not found. Prompt to force add
                if (confirm(`⚠️ 找不到此條碼「${decodedText}」，是否要手動強制加入此商品？`)) {
                    openForceAddModal(decodedText);
                }
                return;
            }
            await checkResponse(res);
            
            const product = await res.json();
            
            // Check if this product belongs to current supplier
            if (product.SUNA !== activeSupplier && product.SUNO !== activeSupplier) {
                if (confirm(`⚠️ 商品 [${product.NAME}] 屬於 [${product.SUNA || '無設定廠商'}]，是否強制加入當前廠商的盤點？`)) {
                    // Temporarily add to the current session's products list so UI renders it
                    if (!productsList.some(p => p.NO === product.NO)) {
                        productsList.unshift(product);
                        renderChecklist(productsList);
                    }
                    openQuantityModal(product);
                }
            } else {
                openQuantityModal(product);
            }
        } catch (err) {
            alert('錯誤: ' + err.message);
        }
    }

    function onScanFailure(error) {
        // ignore scan failures (they are noisy)
    }

    // 7. Force Add implementation
    function openForceAddModal(defaultQuery = '') {
        forceAddModal.classList.remove('hidden');
        forceSearchInput.value = defaultQuery;
        forceSearchResults.innerHTML = '';
        
        if (defaultQuery) {
            triggerForceSearch(defaultQuery);
        }
        
        forceSearchInput.focus();
    }

    btnCloseForce.addEventListener('click', () => {
        forceAddModal.classList.add('hidden');
    });

    // Debounce search
    let forceSearchTimeout = null;
    forceSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearTimeout(forceSearchTimeout);
        if (query.length < 2) {
            forceSearchResults.innerHTML = '';
            return;
        }
        
        forceSearchTimeout = setTimeout(() => {
            triggerForceSearch(query);
        }, 300);
    });

    async function triggerForceSearch(query) {
        forceLoading.classList.remove('hidden');
        forceSearchResults.innerHTML = '';
        try {
            const res = await apiFetch(`/api/products?q=${encodeURIComponent(query)}`);
            await checkResponse(res);
            const list = await res.json();
            
            forceLoading.classList.add('hidden');
            if (list.length === 0) {
                forceSearchResults.innerHTML = '<li class="list-placeholder">無搜尋結果</li>';
                return;
            }

            list.forEach(p => {
                const li = document.createElement('li');
                li.className = 'force-item';
                li.innerHTML = `
                    <div class="force-item-info">
                        <div class="force-item-name">${escapeHtml(p.NAME)}</div>
                        <div class="force-item-code">${escapeHtml(p.NO)} | 庫存: ${p.INVQT} | 廠商: ${escapeHtml(p.SUNA || '未設定')}</div>
                    </div>
                    <button class="btn-add-force">選擇</button>
                `;
                li.addEventListener('click', () => {
                    forceAddModal.classList.add('hidden');
                    // Add to active product list if not exists
                    if (!productsList.some(item => item.NO === p.NO)) {
                        productsList.unshift(p);
                        renderChecklist(productsList);
                    }
                    openQuantityModal(p);
                });
                forceSearchResults.appendChild(li);
            });
        } catch (err) {
            forceLoading.classList.add('hidden');
            forceSearchResults.innerHTML = `<li class="list-placeholder text-danger">搜尋出錯: ${err.message}</li>`;
        }
    }

    // 8. Submit and Clear implementation
    btnClearDraft.addEventListener('click', () => {
        if (confirm('⚠️ 確定要清除當前所有的盤點草稿嗎？此動作無法復原！')) {
            draftCounts = {};
            saveDraftToLocalStorage();
            updateFooterSummary();
            renderChecklist(productsList);
        }
    });

    btnUploadTake.addEventListener('click', async () => {
        const itemsToUpload = Object.values(draftCounts);
        if (itemsToUpload.length === 0) {
            alert('⚠️ 目前無任何盤點數據，請先盤點商品。');
            return;
        }

        // 📅 讓使用者確認盤點日期（預設為今天，可修改為實際盤點日期）
        const todayObj = new Date();
        const todayStr = todayObj.getFullYear() + '-' + String(todayObj.getMonth() + 1).padStart(2, '0') + '-' + String(todayObj.getDate()).padStart(2, '0');
        const chosenDate = prompt(`📅 請確認盤點日期：\n（若今天盤點請直接按確定；若昨天盤點今天才傳，請修改日期）\n\n格式：YYYY-MM-DD`, todayStr);
        if (!chosenDate) return;
        const dateParts = chosenDate.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!dateParts) {
            alert('日期格式錯誤，請使用 YYYY-MM-DD 格式（例如 2026-05-26）');
            return;
        }
        const yyyymmdd = dateParts[1] + dateParts[2] + dateParts[3];

        const confirmMsg = `確定要將這 ${itemsToUpload.length} 筆盤點數據上傳至 ERP？\n\n📅 盤點日期：${chosenDate}\n此動作將自動寫入 take1.dbf！`;
        if (!confirm(confirmMsg)) return;

        // Display uploading badge status
        btnUploadTake.disabled = true;
        btnUploadTake.innerHTML = '<div class="spinner" style="width:16px;height:16px;margin:0 8px 0 0;"></div>上傳中...';

        const now = new Date();
        const hhmmss = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');

        const payload = {
            date: yyyymmdd,
            time: hhmmss,
            items: itemsToUpload
        };

        try {
            const res = await apiFetch('/api/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            await checkResponse(res);
            
            alert(`🎉 上傳成功！已將 ${itemsToUpload.length} 筆項目同步至 ERP 中。\n請在 ERP 系統中確認該日期的盤點單！`);
            
            // Clear local draft
            draftCounts = {};
            saveDraftToLocalStorage();
            updateFooterSummary();
            await loadProducts(); // reload stock counts
        } catch (err) {
            alert('上傳失敗: ' + err.message);
        } finally {
            btnUploadTake.disabled = false;
            btnUploadTake.innerHTML = '<i data-lucide="cloud-lightning" class="btn-icon"></i><span>送出上傳 ERP</span>';
            lucide.createIcons();
        }
    });

    // Helper functions
    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
});
