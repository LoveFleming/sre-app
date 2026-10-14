-- ============================================================================
-- SRE Platform — SQLite Schema v2：GAM（Group Access Management）2026-10-14
--
-- 方向改變：不再用「處 → 部門 → 課」組織樹當權限來源。
-- 改成 **群組制（GAM）**：
--   · 各單位的人自己來「申請」加入群組（access request → 群組 owner/manager 審）
--   · 各群組「自己維護權限」 —— owner/manager 自行核准成員、自行把群組授權到 Workspace
--   · 一個人的可見範圍 = 他所有群組被授權到的 Workspace 的聯集
--
-- 有效存取 = ∪(我的群組 → workspace_acl 權限)   +  ∪(我的群組 capability)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1) 人員
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  username          TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  email             TEXT,
  title             TEXT,
  is_platform_admin INTEGER NOT NULL DEFAULT 0,   -- 極少數：bootstrap / 安全
  source            TEXT NOT NULL DEFAULT 'local' -- local / AD / SSO
);

-- ---------------------------------------------------------------------------
-- 2) 群組（GAM 的核心單位；扁平，可輕量巢狀整理，但巢狀非權威）
-- ---------------------------------------------------------------------------
CREATE TABLE groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL DEFAULT 'unit',   -- unit / service / committee / shared
  description     TEXT,
  parent_group_id TEXT REFERENCES groups(id),     -- 只是整理用，不繼承權限
  join_policy     TEXT NOT NULL DEFAULT 'request' CHECK (join_policy IN ('open','request','invite')),
  created_by      TEXT REFERENCES users(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_groups_parent ON groups(parent_group_id);

-- 群組成員（owner/manager 可自己維護）
CREATE TABLE group_members (
  group_id    TEXT NOT NULL REFERENCES groups(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('owner','manager','member')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','expired')),
  added_by    TEXT,
  joined_at   TEXT NOT NULL,
  expires_at  TEXT,                                -- NULL = 常設（值班/臨時可設 TTL）
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_gm_user ON group_members(user_id, status);

-- 群組層級能力（跨 workspace 的，如 view.audit / notify）
CREATE TABLE group_capabilities (
  group_id   TEXT NOT NULL REFERENCES groups(id),
  capability TEXT NOT NULL,
  PRIMARY KEY (group_id, capability)
);

-- ---------------------------------------------------------------------------
-- 3) Workspace（存取標的；歸屬一個群組）
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,                    -- monitoring / incident / dashboard / runbook / capacity / release
  description    TEXT,
  owner_group_id TEXT REFERENCES groups(id),       -- 主責群組
  shared         INTEGER NOT NULL DEFAULT 0,       -- 平台共用（所有登入者可見）
  sort           INTEGER NOT NULL DEFAULT 0
);

-- 群組 → Workspace 授權（群組 owner 自己維護；可 TTL）
CREATE TABLE workspace_acl (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  group_id     TEXT NOT NULL REFERENCES groups(id),
  permission   TEXT NOT NULL CHECK (permission IN ('view','operate','approve','admin')),
  granted_by   TEXT,
  granted_at   TEXT NOT NULL,
  expires_at   TEXT,
  note         TEXT,
  UNIQUE (workspace_id, group_id)
);
CREATE INDEX idx_acl_group ON workspace_acl(group_id);
CREATE INDEX idx_acl_ws    ON workspace_acl(workspace_id);

-- ---------------------------------------------------------------------------
-- 4) 資源
-- ---------------------------------------------------------------------------
CREATE TABLE resources (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  type           TEXT NOT NULL,                    -- service / incident / dashboard / report
  name           TEXT NOT NULL,
  owner_group_id TEXT REFERENCES groups(id),
  status         TEXT,
  updated_at     TEXT
);
CREATE INDEX idx_res_ws ON resources(workspace_id);

-- ---------------------------------------------------------------------------
-- 5) 申請（各單位的人來申請；由目標的 owner/manager 審）
-- ---------------------------------------------------------------------------
CREATE TABLE access_requests (
  id             TEXT PRIMARY KEY,
  requester_id   TEXT NOT NULL REFERENCES users(id),
  target_type    TEXT NOT NULL CHECK (target_type IN ('group','workspace')),
  target_id      TEXT NOT NULL,                    -- group id 或 workspace id
  group_id       TEXT REFERENCES groups(id),       -- workspace 申請時：用哪個（我管理的）群組去要
  requested_role TEXT,                             -- group: owner/manager/member ; workspace: view/operate/approve/admin
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  decided_by     TEXT REFERENCES users(id),
  decided_at     TEXT,
  decision_note  TEXT,
  expires_at     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_req_target ON access_requests(target_type, target_id, status);
CREATE INDEX idx_req_user   ON access_requests(requester_id, status);

-- ---------------------------------------------------------------------------
-- 6) 稽核 / Session
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,      -- login / request.create / request.approve / acl.grant / member.add ...
  target  TEXT,
  detail  TEXT,
  result  TEXT                -- ok / denied
);
CREATE INDEX idx_audit_ts ON audit_log(ts);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
