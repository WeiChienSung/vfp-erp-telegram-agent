-- 中興醫療物流 V23 資料庫 Schema 與審計日誌設計 (db_schema_v23.sql)

-- 1. 啟用 UUID 擴充功能，供審計與單據使用
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. 建立防篡改審計日誌表 (Audit Trail)
CREATE TABLE IF NOT EXISTS audit_trail (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    table_name VARCHAR(100) NOT NULL,
    action VARCHAR(20) NOT NULL,        -- 'INSERT', 'UPDATE', 'DELETE'
    record_id VARCHAR(100) NOT NULL,    -- 原始記錄的唯一鍵
    old_data JSONB,                     -- 修改前資料
    new_data JSONB,                     -- 修改後資料
    client_ip VARCHAR(50) DEFAULT '127.0.0.1',
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 創建索引以加速法律審計查詢
CREATE INDEX IF NOT EXISTS idx_audit_table_action ON audit_trail(table_name, action);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON audit_trail(changed_at);

-- 3. 建立雙實體商品庫存表 (stock_a 與 stock_b)
CREATE TABLE IF NOT EXISTS stock_a (
    prod_id VARCHAR(50) PRIMARY KEY,
    prod_name VARCHAR(255) NOT NULL,
    qty_stock NUMERIC(12, 4) DEFAULT 0.00,
    price_cost NUMERIC(12, 4) DEFAULT 0.00,
    price_retail NUMERIC(12, 4) DEFAULT 0.00,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stock_b (
    prod_id VARCHAR(50) PRIMARY KEY,
    prod_name VARCHAR(255) NOT NULL,
    qty_stock NUMERIC(12, 4) DEFAULT 0.00,
    price_cost NUMERIC(12, 4) DEFAULT 0.00,
    price_retail NUMERIC(12, 4) DEFAULT 0.00,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. 建立初始 stock 視圖 (預設指向 stock_a)
CREATE OR REPLACE VIEW stock AS SELECT * FROM stock_a;

-- 5. 建立財務尾差調整與發票合規表 (tax_adjustment)
CREATE TABLE IF NOT EXISTS tax_adjustment (
    adj_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_no VARCHAR(50) NOT NULL,       -- 強制關聯原始發票號碼
    erp_doc_no VARCHAR(50) NOT NULL,       -- 強制關聯舊 ERP 單據號
    amount NUMERIC(5, 2) NOT NULL,         -- ±1元安全閥值，差額限制
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_tax_adj_limit CHECK (amount >= -2.00 AND amount <= 2.00) -- 安全閥值約束，大於 2 元直接被資料庫阻斷
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_adj_invoice ON tax_adjustment(invoice_no);

-- 6. 建立自動審計 Trigger 函數
CREATE OR REPLACE FUNCTION process_audit_log()
RETURNS TRIGGER AS $$
DECLARE
    old_row JSONB := NULL;
    new_row JSONB := NULL;
    rec_id VARCHAR(100);
BEGIN
    IF (TG_OP = 'DELETE') THEN
        old_row := to_jsonb(OLD);
        rec_id := OLD.prod_id;
    ELSIF (TG_OP = 'UPDATE') THEN
        old_row := to_jsonb(OLD);
        new_row := to_jsonb(NEW);
        rec_id := NEW.prod_id;
    ELSIF (TG_OP = 'INSERT') THEN
        new_row := to_jsonb(NEW);
        rec_id := NEW.prod_id;
    END IF;

    INSERT INTO audit_trail (table_name, action, record_id, old_data, new_data)
    VALUES (TG_RELNAME, TG_OP, rec_id, old_row, new_row);
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 7. 將 Trigger 綁定至雙實體表，確保任何異動 100% 留下法律審計軌跡
DROP TRIGGER IF EXISTS audit_stock_a_trg ON stock_a;
CREATE TRIGGER audit_stock_a_trg
AFTER INSERT OR UPDATE OR DELETE ON stock_a
FOR EACH ROW EXECUTE FUNCTION process_audit_log();

DROP TRIGGER IF EXISTS audit_stock_b_trg ON stock_b;
CREATE TRIGGER audit_stock_b_trg
AFTER INSERT OR UPDATE OR DELETE ON stock_b
FOR EACH ROW EXECUTE FUNCTION process_audit_log();
