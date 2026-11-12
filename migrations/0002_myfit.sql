-- myFIT 自動取り込み用の列。手動登録は source='manual' のまま external_key は NULL。
ALTER TABLE assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE assignments ADD COLUMN external_key TEXT;
ALTER TABLE assignments ADD COLUMN kind TEXT;
ALTER TABLE assignments ADD COLUMN teacher TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_external_key
    ON assignments (user_id, external_key) WHERE external_key IS NOT NULL;

-- ロックフラグ(myfit_locked)や直近の取り込み結果を置くキー・バリュー表。
CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);
