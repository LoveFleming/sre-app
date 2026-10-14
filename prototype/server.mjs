/**
 * server.mjs — SRE Platform prototype v2：GAM（Group Access Management）
 *
 * 登入 → 看你的工作站；沒有的人可以「申請」；群組 owner/manager「自己維護權限」。
 * 零依賴：node:http + node:sqlite。先跑 `node seed.mjs`，再 `node server.mjs`。
 * 預設 http://localhost:5180
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
const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

if (!existsSync(DB_PATH)) {
  console.error("找不到 data.db — 請先執行： node seed.mjs");
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
const q = (sql) => db.prepare(sql);

// permission 強度
const PERM_RANK = { view: 1, operate: 2, approve: 3, admin: 4 };
const PERM_CAPS = {
  view: ["view.overview", "view.incidents"],
  operate: ["run.inspection", "open.incident", "view.grafana", "view.inspections", "view.agents"],
  approve: ["approve"],
  admin: ["configure", "manage.acl"],
};
const isActive = (row) => !row.expires_at || new Date(row.expires_at) > new Date();

// ---------------------------------------------------------------- 存取解析
function myGroups(userId) {
  return q(
    `SELECT gm.group_id, gm.member_role, gm.expires_at, g.name, g.slug, g.kind, g.join_policy
     FROM group_members gm JOIN groups g ON g.id=gm.group_id
     WHERE gm.user_id=? AND gm.status='active'`
  ).all(userId).filter(isActive);
}

function isPlatformAdmin(userId) {
  return !!q("SELECT is_platform_admin FROM users WHERE id=?").get(userId)?.is_platform_admin;
}

/** 我能不能管理某群組（owner/manager 或平台管理） */
function canManage(userId, groupId) {
  if (isPlatformAdmin(userId)) return true;
  const m = q("SELECT member_role FROM group_members WHERE group_id=? AND user_id=? AND status='active'").get(groupId, userId);
  return !!m && (m.member_role === "owner" || m.member_role === "manager");
}

/** 我的可見 workspaces：∪(我的群組 → workspace_acl)，取最強權限 */
function myWorkspaces(userId) {
  const admin = isPlatformAdmin(userId);
  const gids = myGroups(userId).map((g) => g.group_id);
  const all = q("SELECT * FROM workspaces ORDER BY sort, name").all();
  const out = [];
  for (const w of all) {
    let perm = null;
    let via = [];
    if (admin) {
      perm = "admin";
      via = ["平台管理"];
    }
    if (gids.length) {
      const ph = gids.map(() => "?").join(",");
      const rows = q(`SELECT group_id, permission, expires_at FROM workspace_acl WHERE workspace_id=? AND group_id IN (${ph})`).all(w.id, ...gids);
      for (const r of rows.filter(isActive)) {
        if (!perm || PERM_RANK[r.permission] > PERM_RANK[perm]) perm = r.permission;
        via.push(q("SELECT name FROM groups WHERE id=?").get(r.group_id)?.name);
      }
    }
    if (!perm && w.shared) { perm = "view"; via = ["共用"]; }
    if (!perm) continue;
    out.push({
      id: w.id, name: w.name, kind: w.kind, description: w.description, shared: !!w.shared,
      ownerGroup: q("SELECT name FROM groups WHERE id=?").get(w.owner_group_id)?.name,
      permission: perm, via,
    });
  }
  return out;
}

function myCapabilities(userId) {
  const caps = new Set();
  for (const w of myWorkspaces(userId)) for (const c of PERM_CAPS[w.permission] || []) caps.add(c);
  for (const g of myGroups(userId)) {
    for (const c of q("SELECT capability FROM group_capabilities WHERE group_id=?").all(g.group_id)) caps.add(c.capability);
  }
  if (isPlatformAdmin(userId)) { caps.add("view.audit"); caps.add("manage.groups"); }
  return [...caps];
}

function audit(userId, action, target, detail, result = "ok") {
  q("INSERT INTO audit_log(ts,user_id,action,target,detail,result) VALUES(?,?,?,?,?,?)").run(now(), userId, action, target, detail, result);
}

function makeSession(userId) {
  const token = randomUUID();
  q("INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)").run(token, userId, now(), new Date(Date.now() + 12 * 3600e3).toISOString());
  return token;
}
function userFromReq(req) {
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const s = q("SELECT * FROM sessions WHERE token=?").get(token);
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return s.user_id;
}

// ---------------------------------------------------------------- http
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const method = req.method;
  const body = async () => JSON.parse((await readBody(req)) || "{}");

  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(__dirname, "public", "index.html")));
    return;
  }

  if (p === "/api/login" && method === "POST") {
    const { username, password } = await body();
    const u = q("SELECT * FROM users WHERE username=?").get(username);
    if (!u || u.password_hash !== sha(password || "")) { audit(u?.id || null, "login", username, "bad credentials", "denied"); return json(res, 401, { error: "帳號或密碼錯誤" }); }
    const token = makeSession(u.id);
    audit(u.id, "login", u.username, "ok");
    return json(res, 200, { token, user: { id: u.id, username: u.username, displayName: u.display_name } });
  }

  const userId = userFromReq(req);
  if (!userId) return json(res, 401, { error: "未登入" });
  const me = q("SELECT * FROM users WHERE id=?").get(userId);
  const gids = myGroups(userId).map((g) => g.group_id);
  const can = (c) => myCapabilities(userId).includes(c);

  // ---- 我是誰：群組、能力 ----
  if (p === "/api/me") {
    return json(res, 200, {
      user: { id: me.id, username: me.username, displayName: me.display_name, title: me.title, isPlatformAdmin: !!me.is_platform_admin },
      groups: myGroups(userId).map((g) => ({ id: g.group_id, name: g.name, role: g.member_role, temporary: !!g.expires_at, expiresAt: g.expires_at })),
      capabilities: myCapabilities(userId),
    });
  }

  // ---- 我的工作站（有權存取的） ----
  if (p === "/api/access") {
    return json(res, 200, { workspaces: myWorkspaces(userId) });
  }

  // ---- 探索：所有群組 + 我是否已加入 / 所有 workspace + 我是否可見 ----
  if (p === "/api/discover") {
    const mine = new Set(gids);
    const groups = q("SELECT * FROM groups ORDER BY kind, name").all().map((g) => ({
      id: g.id, name: g.name, kind: g.kind, description: g.description, joinPolicy: g.join_policy,
      memberCount: q("SELECT COUNT(*) c FROM group_members WHERE group_id=? AND status='active'").get(g.id).c,
      joined: mine.has(g.id),
      pending: !!q("SELECT 1 FROM access_requests WHERE requester_id=? AND target_type='group' AND target_id=? AND status='pending'").get(userId, g.id),
    }));
    const visible = new Set(myWorkspaces(userId).map((w) => w.id));
    const workspaces = q("SELECT * FROM workspaces ORDER BY sort, name").all().map((w) => ({
      id: w.id, name: w.name, kind: w.kind, description: w.description,
      ownerGroup: q("SELECT name FROM groups WHERE id=?").get(w.owner_group_id)?.name,
      visible: visible.has(w.id),
      pending: !!q("SELECT 1 FROM access_requests WHERE requester_id=? AND target_type='workspace' AND target_id=? AND status='pending'").get(userId, w.id),
    }));
    const myManagedGroups = myGroups(userId).filter((g) => g.member_role === "owner" || g.member_role === "manager").map((g) => ({ id: g.group_id, name: g.name }));
    if (isPlatformAdmin(userId)) groups.forEach((g) => {});
    return json(res, 200, { groups, workspaces, myManagedGroups: isPlatformAdmin(userId) ? q("SELECT id,name FROM groups").all() : myManagedGroups });
  }

  // ---- 我的申請 ----
  if (p === "/api/requests") {
    const rows = q("SELECT * FROM access_requests WHERE requester_id=? ORDER BY created_at DESC").all(userId);
    return json(res, 200, { requests: rows.map((r) => ({ ...r, targetName: targetName(r.target_type, r.target_id) })) });
  }

  // ---- 送出申請 ----
  if (p === "/api/requests" && method === "POST") {
    const b = await body();
    if (b.target_type === "group") {
      const g = q("SELECT * FROM groups WHERE id=?").get(b.target_id);
      if (!g) return json(res, 404, { error: "群組不存在" });
      if (q("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND status='active'").get(g.id, userId)) return json(res, 400, { error: "你已在這個群組" });
      const id = uid("q");
      q("INSERT INTO access_requests(id,requester_id,target_type,target_id,group_id,requested_role,reason,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)")
        .run(id, userId, "group", g.id, null, b.requested_role || "member", b.reason || "", now());
      // open policy：直接核准
      if (g.join_policy === "open") return approveRequest(id, userId, "open policy 自動核准");
      audit(userId, "request.create", g.id, `join ${g.name}`);
      return json(res, 200, { ok: true, id, auto: false });
    }
    if (b.target_type === "workspace") {
      const w = q("SELECT * FROM workspaces WHERE id=?").get(b.target_id);
      if (!w) return json(res, 404, { error: "Workspace 不存在" });
      if (!b.group_id || !canManage(userId, b.group_id)) return json(res, 403, { error: "需指定一個你能管理的群組來申請" });
      const id = uid("q");
      q("INSERT INTO access_requests(id,requester_id,target_type,target_id,group_id,requested_role,reason,status,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)")
        .run(id, userId, "workspace", w.id, b.group_id, b.requested_role || "view", b.reason || "", now());
      audit(userId, "request.create", w.id, `acl ${b.requested_role || "view"} via ${b.group_id}`);
      return json(res, 200, { ok: true, id, auto: false });
    }
    return json(res, 400, { error: "target_type 需為 group 或 workspace" });
  }

  // ---- 管理某群組（owner/manager）----
  const mm = p.match(/^\/api\/manage\/([^/]+)$/);
  if (mm && method === "GET") {
    const gid = decodeURIComponent(mm[1]);
    if (!canManage(userId, gid)) return json(res, 403, { error: "你不是這個群組的 owner/manager" });
    const g = q("SELECT * FROM groups WHERE id=?").get(gid);
    const members = q(`SELECT gm.user_id, u.display_name, gm.member_role, gm.expires_at FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND gm.status='active'`).all(gid)
      .map((m) => ({ ...m, temporary: !!m.expires_at }));
    // 待審：① 加入本群組 ② 用本群組申請的 workspace 存取
    const pendingJoin = q("SELECT r.*, u.display_name FROM access_requests r JOIN users u ON u.id=r.requester_id WHERE r.target_type='group' AND r.target_id=? AND r.status='pending'").all(gid);
    // 待審的 workspace 存取 = 本群組對該 workspace 有 admin（才審得動）+ 平台管理看全部
    const adminWs = q("SELECT workspace_id FROM workspace_acl WHERE group_id=? AND permission='admin'").all(gid).map((x) => x.workspace_id);
    let pendingAcl = [];
    if (isPlatformAdmin(userId)) {
      pendingAcl = q("SELECT r.*, u.display_name FROM access_requests r JOIN users u ON u.id=r.requester_id WHERE r.target_type='workspace' AND r.status='pending'").all();
    } else if (adminWs.length) {
      const ph = adminWs.map(() => "?").join(",");
      pendingAcl = q(`SELECT r.*, u.display_name FROM access_requests r JOIN users u ON u.id=r.requester_id WHERE r.target_type='workspace' AND r.status='pending' AND r.target_id IN (${ph})`).all(...adminWs);
    }
    pendingAcl = pendingAcl.map((r) => ({ ...r, targetName: targetName("workspace", r.target_id) }));
    const acls = q(`SELECT wa.id, wa.workspace_id, w.name, wa.permission, wa.expires_at FROM workspace_acl wa JOIN workspaces w ON w.id=wa.workspace_id WHERE wa.group_id=?`).all(gid)
      .map((a) => ({ ...a, temporary: !!a.expires_at }));
    const allWs = q("SELECT id,name FROM workspaces ORDER BY sort, name").all();
    const orgUsers = q("SELECT id, display_name FROM users ORDER BY display_name").all();
    return json(res, 200, { group: { id: g.id, name: g.name, kind: g.kind, joinPolicy: g.join_policy }, members, pendingJoin, pendingAcl, acls, allWorkspaces: allWs, allUsers: orgUsers });
  }

  // ---- 審核申請 ----
  const am = p.match(/^\/api\/requests\/([^/]+)\/decide$/);
  if (am && method === "POST") {
    const b = await body();
    const r = q("SELECT * FROM access_requests WHERE id=?").get(decodeURIComponent(am[1]));
    if (!r || r.status !== "pending") return json(res, 400, { error: "申請不存在或已處理" });
    const approverGroup = r.target_type === "group" ? r.target_id : (whichGroupAdminsWorkspace(r.target_id) || r.group_id);
    if (!canManage(userId, approverGroup)) { audit(userId, "request.decide", r.id, "no authority", "denied"); return json(res, 403, { error: "你無權審核此申請" }); }
    if (b.decision === "approve") { approveRequest(r.id, userId, b.note || ""); return json(res, 200, { ok: true }); }
    q("UPDATE access_requests SET status='rejected', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(userId, now(), b.note || "", r.id);
    audit(userId, "request.reject", r.id, targetName(r.target_type, r.target_id));
    return json(res, 200, { ok: true });
  }

  // ---- 群組維護：加成員 ----
  const addM = p.match(/^\/api\/manage\/([^/]+)\/members$/);
  if (addM && method === "POST") {
    const gid = decodeURIComponent(addM[1]);
    if (!canManage(userId, gid)) return json(res, 403, { error: "無權管理" });
    const b = await body();
    if (!b.user_id) return json(res, 400, { error: "缺 user_id" });
    const exp = b.expiresAt || null;
    const exist = q("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(gid, b.user_id);
    if (exist) q("UPDATE group_members SET member_role=?, status='active', expires_at=?, added_by=? WHERE group_id=? AND user_id=?").run(b.member_role || "member", exp, userId, gid, b.user_id);
    else q("INSERT INTO group_members(group_id,user_id,member_role,status,added_by,joined_at,expires_at) VALUES(?,?,?,'active',?,?,?)").run(gid, b.user_id, b.member_role || "member", userId, now(), exp);
    audit(userId, "member.add", gid, `${b.user_id} as ${b.member_role || "member"}${exp ? " (TTL)" : ""}`);
    return json(res, 200, { ok: true });
  }
  const rmM = p.match(/^\/api\/manage\/([^/]+)\/members\/([^/]+)$/);
  if (rmM && method === "DELETE") {
    const gid = decodeURIComponent(rmM[1]), target = decodeURIComponent(rmM[2]);
    if (!canManage(userId, gid)) return json(res, 403, { error: "無權管理" });
    q("UPDATE group_members SET status='expired' WHERE group_id=? AND user_id=?").run(gid, target);
    audit(userId, "member.remove", gid, target);
    return json(res, 200, { ok: true });
  }

  // ---- 群組維護：授權 / 回收 workspace ----
  const aclM = p.match(/^\/api\/manage\/([^/]+)\/acl$/);
  if (aclM && method === "POST") {
    const gid = decodeURIComponent(aclM[1]);
    if (!canManage(userId, gid)) return json(res, 403, { error: "無權管理" });
    const b = await body();
    if (!b.workspace_id || !b.permission) return json(res, 400, { error: "缺 workspace_id / permission" });
    const exp = b.expiresAt || null;
    const exist = q("SELECT id FROM workspace_acl WHERE workspace_id=? AND group_id=?").get(b.workspace_id, gid);
    if (exist) q("UPDATE workspace_acl SET permission=?, expires_at=?, granted_by=?, granted_at=? WHERE id=?").run(b.permission, exp, userId, now(), exist.id);
    else q("INSERT INTO workspace_acl(id,workspace_id,group_id,permission,granted_by,granted_at,expires_at) VALUES(?,?,?,?,?,?,?)").run(uid("a"), b.workspace_id, gid, b.permission, userId, now(), exp);
    audit(userId, "acl.grant", b.workspace_id, `${gid} → ${b.permission}${exp ? " (TTL)" : ""}`);
    return json(res, 200, { ok: true });
  }
  const aclR = p.match(/^\/api\/manage\/([^/]+)\/acl\/([^/]+)$/);
  if (aclR && method === "DELETE") {
    const gid = decodeURIComponent(aclR[1]), wsid = decodeURIComponent(aclR[2]);
    if (!canManage(userId, gid)) return json(res, 403, { error: "無權管理" });
    q("DELETE FROM workspace_acl WHERE group_id=? AND workspace_id=?").run(gid, wsid);
    audit(userId, "acl.revoke", wsid, gid);
    return json(res, 200, { ok: true });
  }

  // ---- workspace 詳情（限可見）----
  const wm = p.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wm && method === "GET") {
    const wid = decodeURIComponent(wm[1]);
    const vis = myWorkspaces(userId).find((w) => w.id === wid);
    if (!vis) { audit(userId, "view.workspace", wid, "out of scope", "denied"); return json(res, 403, { error: "無權存取這個 workspace" }); }
    const resources = q("SELECT * FROM resources WHERE workspace_id=? ORDER BY type, name").all(wid)
      .map((r) => ({ ...r, ownerGroupName: q("SELECT name FROM groups WHERE id=?").get(r.owner_group_id)?.name }));
    audit(userId, "view.workspace", wid, `${resources.length} resources`);
    return json(res, 200, { workspace: vis, resources });
  }

  // ---- 稽核 ----
  if (p === "/api/audit") {
    if (!can("view.audit")) return json(res, 403, { error: "無權檢視稽核日誌" });
    const rows = q("SELECT a.*, u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 150").all();
    return json(res, 200, { entries: rows });
  }

  json(res, 404, { error: "not found" });
});

// ---------------------------------------------------------------- helpers
function targetName(type, id) {
  if (type === "group") return q("SELECT name FROM groups WHERE id=?").get(id)?.name || id;
  return q("SELECT name FROM workspaces WHERE id=?").get(id)?.name || id;
}
function whichGroupAdminsWorkspace(wid) {
  const a = q("SELECT group_id FROM workspace_acl WHERE workspace_id=? AND permission='admin' LIMIT 1").get(wid);
  return a?.group_id || null;
}
function approveRequest(requestId, deciderId, note) {
  const r = q("SELECT * FROM access_requests WHERE id=?").get(requestId);
  if (r.target_type === "group") {
    const exist = q("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(r.target_id, r.requester_id);
    if (exist) q("UPDATE group_members SET status='active', member_role=?, added_by=? WHERE group_id=? AND user_id=?").run(r.requested_role || "member", deciderId, r.target_id, r.requester_id);
    else q("INSERT INTO group_members(group_id,user_id,member_role,status,added_by,joined_at) VALUES(?,?,?,'active',?,?)").run(r.target_id, r.requester_id, r.requested_role || "member", deciderId, now());
  } else {
    const ws = r.target_id, gid = r.group_id;
    const exist = q("SELECT id FROM workspace_acl WHERE workspace_id=? AND group_id=?").get(ws, gid);
    if (exist) q("UPDATE workspace_acl SET permission=?, granted_by=?, granted_at=? WHERE id=?").run(r.requested_role || "view", deciderId, now(), exist.id);
    else q("INSERT INTO workspace_acl(id,workspace_id,group_id,permission,granted_by,granted_at) VALUES(?,?,?,?,?,?)").run(uid("a"), ws, gid, r.requested_role || "view", deciderId, now());
  }
  q("UPDATE access_requests SET status='approved', decided_by=?, decided_at=?, decision_note=? WHERE id=?").run(deciderId, now(), note || "", requestId);
  audit(deciderId, "request.approve", requestId, targetName(r.target_type, r.target_id));
}

server.listen(PORT, () => {
  console.log(`\n🛡️  SRE Platform GAM prototype → http://localhost:${PORT}`);
  console.log("   示範帳號（密碼 demo123）：");
  console.log("     admin      平台管理員(全權)");
  console.log("     lead.mon   監控組 owner（可審申請/維護 ACL）");
  console.log("     eng.mon    監控組 member");
  console.log("     lead.app1  應用一組 owner");
  console.log("     auditor    稽核組 owner（唯讀 + 4h 借調 NOC）");
  console.log("     newbie     新人（尚無群組，已送加入監控組申請）");
  console.log("");
});
