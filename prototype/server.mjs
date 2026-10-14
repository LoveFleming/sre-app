/**
 * server.mjs — SRE Platform prototype：登入 → 看到哪些 Workspace（Azure 式階層）
 *
 * 零依賴：node:http + node:sqlite。先跑 `node seed.mjs`，再 `node server.mjs`。
 * 預設 http://localhost:5180
 *
 * 存取三軸：Capability(角色) ∩ DataScope(組織樹子樹) ∩ Action
 * 每個 API 都在 server 端重驗 scope（UI 藏起來 ≠ 安全）。
 */
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "data.db");
const PORT = process.env.PORT ? Number(process.env.PORT) : 5180;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();

if (!existsSync(DB_PATH)) {
  console.error("找不到 data.db — 請先執行： node seed.mjs");
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);

// ---------------------------------------------------------------- 存取解析
const isActive = (g) => !g.expires_at || new Date(g.expires_at) > new Date();

/** 某節點的子樹（含自己） */
function subtreeIds(orgId) {
  const rows = db.prepare(
    `WITH RECURSIVE t(id) AS (
       SELECT ? UNION ALL
       SELECT o.id FROM org_units o JOIN t ON o.parent_id = t.id
     ) SELECT id FROM t`
  ).all(orgId);
  return rows.map((r) => r.id);
}

/** 算一個人的有效權限（View Model 的來源） */
function computeAccess(userId) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  if (!user) return null;
  const allGrants = db.prepare("SELECT * FROM grants WHERE user_id=?").all(userId);
  const active = allGrants.filter(isActive);

  const caps = new Set();
  const scope = new Set();
  const roles = [];
  for (const g of active) {
    const capRows = db.prepare("SELECT capability FROM role_capabilities WHERE role_key=?").all(g.role_key);
    capRows.forEach((c) => caps.add(c.capability));
    subtreeIds(g.org_unit_id).forEach((id) => scope.add(id));
    const role = db.prepare("SELECT name FROM roles WHERE key=?").get(g.role_key);
    const org = db.prepare("SELECT name FROM org_units WHERE id=?").get(g.org_unit_id);
    roles.push({
      roleKey: g.role_key,
      roleName: role?.name || g.role_key,
      orgId: g.org_unit_id,
      orgName: org?.name || g.org_unit_id,
      expiresAt: g.expires_at,
      temporary: !!g.expires_at,
      note: g.note,
    });
  }
  return { user, capabilities: [...caps], scopeOrgIds: [...scope], roles };
}

function orgBreadcrumb(orgId) {
  const chain = [];
  let cur = db.prepare("SELECT * FROM org_units WHERE id=?").get(orgId);
  while (cur) {
    chain.unshift({ id: cur.id, name: cur.name, level: cur.level });
    cur = cur.parent_id ? db.prepare("SELECT * FROM org_units WHERE id=?").get(cur.parent_id) : null;
  }
  return chain;
}

/** 可見的 workspaces（給定 access） */
function visibleWorkspaces(access) {
  const scope = new Set(access.scopeOrgIds);
  const all = db.prepare("SELECT * FROM workspaces ORDER BY sort, name").all();
  const out = [];
  for (const w of all) {
    const inScope = scope.has(w.org_unit_id);
    const links = db.prepare("SELECT org_unit_id, relationship FROM workspace_org_links WHERE workspace_id=?").all(w.id);
    const linked = links.some((l) => scope.has(l.org_unit_id));
    if (!inScope && !linked && !w.shared) continue;
    const reason = inScope ? "own-scope" : linked ? "linked" : "shared";
    out.push({
      id: w.id,
      name: w.name,
      kind: w.kind,
      description: w.description,
      shared: !!w.shared,
      reason,
      orgId: w.org_unit_id,
      orgName: db.prepare("SELECT name FROM org_units WHERE id=?").get(w.org_unit_id)?.name,
      breadcrumb: orgBreadcrumb(w.org_unit_id),
    });
  }
  return out;
}

function audit(userId, action, target, detail, result = "ok") {
  db.prepare("INSERT INTO audit_log(ts,user_id,action,target,detail,result) VALUES(?,?,?,?,?,?)")
    .run(now(), userId, action, target, detail, result);
}

// ---------------------------------------------------------------- session
function makeSession(userId) {
  const token = randomUUID();
  const exp = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(token, userId, now(), exp);
  return token;
}
function userFromReq(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return s.user_id;
}

// ---------------------------------------------------------------- http
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
};
const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ---- 靜態頁 ----
  if (p === "/" || p === "/index.html") {
    const html = readFileSync(join(__dirname, "public", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ---- 登入 ----
  if (p === "/api/login" && req.method === "POST") {
    const { username, password } = JSON.parse((await readBody(req)) || "{}");
    const u = db.prepare("SELECT * FROM users WHERE username=?").get(username);
    if (!u || u.password_hash !== sha(password || "")) {
      audit(u?.id || null, "login", username, "bad credentials", "denied");
      return json(res, 401, { error: "帳號或密碼錯誤" });
    }
    const token = makeSession(u.id);
    audit(u.id, "login", u.username, "ok");
    return json(res, 200, { token, user: { id: u.id, username: u.username, displayName: u.display_name } });
  }

  // 以下都要登入
  const userId = userFromReq(req);
  if (!userId) return json(res, 401, { error: "未登入" });
  const access = computeAccess(userId);
  if (!access) return json(res, 401, { error: "使用者不存在" });
  const can = (c) => access.capabilities.includes(c);

  // ---- /api/me：登入者能看到什麼能力、範圍、角色 ----
  if (p === "/api/me") {
    return json(res, 200, {
      user: {
        id: access.user.id,
        username: access.user.username,
        displayName: access.user.display_name,
        title: access.user.title,
        orgId: access.user.org_unit_id,
        orgName: db.prepare("SELECT name FROM org_units WHERE id=?").get(access.user.org_unit_id)?.name,
      },
      roles: access.roles,
      capabilities: access.capabilities,
      scopeOrgIds: access.scopeOrgIds,
      scopeNames: access.scopeOrgIds
        .map((id) => db.prepare("SELECT name,level FROM org_units WHERE id=?").get(id))
        .filter(Boolean)
        .map((o) => o.name),
    });
  }

  // ---- /api/orgs：組織樹 + 我能不能進（像 Azure 的目錄）----
  if (p === "/api/orgs") {
    const scope = new Set(access.scopeOrgIds);
    const rows = db.prepare("SELECT * FROM org_units ORDER BY sort, name").all();
    // 只回傳看得到的節點（自己子樹）；維護樹狀
    const visible = rows.filter((o) => scope.has(o.id) || o.parent_id === null);
    const byId = new Map(visible.map((o) => [o.id, { ...o, accessible: scope.has(o.id), children: [] }]));
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parent_id ? byId.get(node.parent_id) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return json(res, 200, { roots });
  }

  // ---- /api/workspaces：我看到的 workspace 清單 ----
  if (p === "/api/workspaces") {
    return json(res, 200, { workspaces: visibleWorkspaces(access) });
  }

  // ---- /api/workspaces/:id：單一 workspace + 範圍過濾後的資源 ----
  const m = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const vis = visibleWorkspaces(access).find((w) => w.id === id);
    if (!vis) {
      audit(userId, "view.workspace", id, "out of scope", "denied");
      return json(res, 403, { error: "無權存取這個 workspace" });
    }
    const scope = new Set(access.scopeOrgIds);
    const allRes = db.prepare("SELECT * FROM resources WHERE workspace_id=? ORDER BY type, name").all(id);
    const shown = allRes.filter((r) => scope.has(r.owner_org_id));
    const hidden = allRes.length - shown.length;
    audit(userId, "view.workspace", id, `shown=${shown.length} hidden=${hidden}`);
    return json(res, 200, {
      workspace: vis,
      resources: shown.map((r) => ({
        ...r,
        ownerOrgName: db.prepare("SELECT name FROM org_units WHERE id=?").get(r.owner_org_id)?.name,
      })),
      hiddenCount: hidden,
    });
  }

  // ---- /api/audit：稽核日誌（需 view.audit）----
  if (p === "/api/audit") {
    if (!can("view.audit")) return json(res, 403, { error: "無權檢視稽核日誌" });
    const rows = db.prepare("SELECT a.*, u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100").all();
    return json(res, 200, { entries: rows });
  }

  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`\n🛡️  SRE Platform prototype → http://localhost:${PORT}`);
  console.log("   示範帳號（密碼 demo123）：admin / chief.info / mgr.sysops / lead.mon / eng.mon / eng.app1 / viewer.app2 / auditor / noc.duty\n");
});
