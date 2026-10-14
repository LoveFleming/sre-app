-- ============================================================================
-- SRE Platform — SQLite Schema v1 (2026-10-14)
--
-- 定位：Platform level。一個人登入後，能看到「哪些 workspace / 哪些資料」。
-- 階層類比 Azure：  處(Tenant) → 部門(Management Group) → 課(Subscription)
--                   → Workspace(Resource Group) → Resource
--
-- 存取三軸：Capability(角色) ∩ DataScope(組織樹) ∩ Action(授權動作)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1) 組織樹：處 → 部門 → 課（每節點 = 權限節點 + 資料邊界）
-- ---------------------------------------------------------------------------
CREATE TABLE org_units (
  id         TEXT PRIMARY KEY,                 -- 如 'info' / 'info.sysops'
  parent_id  TEXT REFERENCES org_units(id),
  level      TEXT NOT NULL CHECK (level IN ('platform','office','department','section')),
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,             -- 如 '/info/sysops/monitoring'（子樹查詢用）
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_org_parent ON org_units(parent_id);

-- ---------------------------------------------------------------------------
-- 2) 人員（prototype：帳密用 sha256；正式版走 AD/SSO）
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  email         TEXT,
  org_unit_id   TEXT NOT NULL REFERENCES org_units(id),  -- 人掛在「課」
  title         TEXT,
  source        TEXT NOT NULL DEFAULT 'local'            -- local / AD / SSO
);

-- ---------------------------------------------------------------------------
-- 3) 角色（綁「層級」不綁人；人調動只改 grant）
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  key         TEXT PRIMARY KEY,             -- platform.admin / office.chief / dept.manager / section.lead / engineer.oncall / viewer / auditor / noc
  name        TEXT NOT NULL,
  level_rank  INTEGER NOT NULL,             -- 0=platform 1=office 2=department 3=section 9=cross
  description TEXT
);

CREATE TABLE role_capabilities (
  role_key   TEXT NOT NULL REFERENCES roles(key),
  capability TEXT NOT NULL,                 -- view.overview / view.incidents / run.inspection / approve / configure ...
  PRIMARY KEY (role_key, capability)
);

-- ---------------------------------------------------------------------------
-- 4) 授權：role 綁在某個組織節點上，可 TTL（值班 / 事件臨時 / 委派）
-- ---------------------------------------------------------------------------
CREATE TABLE grants (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  role_key    TEXT NOT NULL REFERENCES roles(key),
  org_unit_id TEXT NOT NULL REFERENCES org_units(id),
  granted_by  TEXT,
  granted_at  TEXT NOT NULL,
  expires_at  TEXT,                         -- NULL = 常設（職務）
  note        TEXT
);
CREATE INDEX idx_grants_user ON grants(user_id);
CREATE INDEX idx_grants_org  ON grants(org_unit_id);

-- ---------------------------------------------------------------------------
-- 5) Workspace（Azure Resource Group 角色）— 登入後「看到的」主要單位
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  org_unit_id TEXT NOT NULL REFERENCES org_units(id),   -- 歸屬課
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- monitoring / incident / dashboard / runbook / capacity / release
  description TEXT,
  shared      INTEGER NOT NULL DEFAULT 0,   -- 平台共用（跨單位可見）
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_ws_org ON workspaces(org_unit_id);

-- 關聯單位（共用/關聯 workspace 例外；關係列在此）
CREATE TABLE workspace_org_links (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  org_unit_id  TEXT NOT NULL REFERENCES org_units(id),
  relationship TEXT NOT NULL DEFAULT 'related',   -- shared / related
  PRIMARY KEY (workspace_id, org_unit_id)
);

-- ---------------------------------------------------------------------------
-- 6) 資源（workspace 裡的服務 / 事件 / 儀表板 / 報告）
-- ---------------------------------------------------------------------------
CREATE TABLE resources (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  type          TEXT NOT NULL,              -- service / incident / dashboard / report
  name          TEXT NOT NULL,
  owner_org_id  TEXT NOT NULL REFERENCES org_units(id),
  status        TEXT,
  tags          TEXT,                       -- JSON 字串
  updated_at    TEXT
);
CREATE INDEX idx_res_ws    ON resources(workspace_id);
CREATE INDEX idx_res_owner ON resources(owner_org_id);

-- ---------------------------------------------------------------------------
-- 7) 稽核（誰、何時、看了/做了什麼、依據哪個 grant）
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,                    -- login / view.workspace / view.resource ...
  target  TEXT,
  detail  TEXT,
  result  TEXT                              -- ok / denied
);
CREATE INDEX idx_audit_ts ON audit_log(ts);

-- ---------------------------------------------------------------------------
-- 8) Session（prototype 用；正式版走 JWT / SSO session）
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
