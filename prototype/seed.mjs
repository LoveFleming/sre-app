/**
 * seed.mjs — 建立 SQLite DB + 灌示範資料（SRE Platform GAM prototype v2）
 *
 * 用法： node seed.mjs
 * 依 schema.sql 建表；灌：人員 / 群組 / 成員 / 群組能力 / workspace / ACL /
 * 資源 / 申請單 / 稽核空表。密碼一律 demo123（sha256）。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "data.db");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const in4h = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
const PWD = sha("demo123");

if (existsSync(DB_PATH)) rmSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf-8"));

const ins = (sql) => db.prepare(sql);

// ---------------------------------------------------------------- 人員
const users = [
  ["u.admin", "admin", "平台管理員 Adam", "平台工程師", 1],
  ["u.leadmon", "lead.mon", "王組長", "監控組長", 0],
  ["u.engmon", "eng.mon", "李工程師", "值班工程師", 0],
  ["u.leadplat", "lead.plat", "黃組長", "平台工程組長", 0],
  ["u.leadapp1", "lead.app1", "陳組長", "應用一組長", 0],
  ["u.engapp1", "eng.app1", "張工程師", "應用一組工程師", 0],
  ["u.leadapp2", "lead.app2", "林組長", "應用二組長", 0],
  ["u.viewapp2", "viewer.app2", "吳觀察", "觀察者", 0],
  ["u.leadsre", "lead.sre", "許組長", "SRE 核心組長", 0],
  ["u.audit", "auditor", "資安稽核", "資安稽核員", 0],
  ["u.noc", "noc.duty", "NOC 值班", "值班中心", 0],
  ["u.newbie", "newbie", "王小新", "新進工程師", 0],
];
const iu = ins("INSERT INTO users(id,username,password_hash,display_name,email,title,is_platform_admin,source) VALUES(?,?,?,?,?,?,?,?)");
users.forEach((u) => iu.run(u[0], u[1], PWD, u[2], `${u[1]}@example.com`, u[3], u[4], "local"));

// ---------------------------------------------------------------- 群組
const groups = [
  ["g.platadmins", "平台管理組", "platform-admins", "committee", "平台管理與 bootstrap", null, "invite"],
  ["g.monitoring", "監控組", "monitoring", "unit", "核心系統監控與告警", null, "request"],
  ["g.plateng", "平台工程組", "platform-eng", "unit", "容量與發布", null, "request"],
  ["g.app1", "應用一組", "app1", "unit", "ERP 應用維運", null, "request"],
  ["g.app2", "應用二組", "app2", "unit", "CRM 應用維運", null, "request"],
  ["g.sre", "SRE 核心組", "sre-core", "unit", "Runbook / 演練 / 可靠性工程", null, "request"],
  ["g.noc", "值班中心", "noc", "shared", "跨單位值班與通報", null, "invite"],
  ["g.audit", "稽核組", "audit", "committee", "資安/合規稽核（唯讀）", null, "invite"],
];
const ig = ins("INSERT INTO groups(id,name,slug,kind,description,parent_group_id,join_policy,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)");
groups.forEach((g) => ig.run(g[0], g[1], g[2], g[3], g[4], g[5], g[6], "u.admin", now()));

// ---------------------------------------------------------------- 成員
const members = [
  ["g.platadmins", "u.admin", "owner", null],
  ["g.monitoring", "u.leadmon", "owner", null],
  ["g.monitoring", "u.engmon", "member", null],
  ["g.plateng", "u.leadplat", "owner", null],
  ["g.app1", "u.leadapp1", "owner", null],
  ["g.app1", "u.engapp1", "member", null],
  ["g.app2", "u.leadapp2", "owner", null],
  ["g.app2", "u.viewapp2", "member", null],
  ["g.sre", "u.leadsre", "owner", null],
  ["g.noc", "u.noc", "owner", null],
  ["g.audit", "u.audit", "owner", null],
  // NOC 成員借調：資安稽核臨時加入值班中心（4h TTL）
  ["g.noc", "u.audit", "member", in4h],
];
const im = ins("INSERT INTO group_members(group_id,user_id,member_role,status,added_by,joined_at,expires_at) VALUES(?,?,?,'active',?,?,?)");
members.forEach((m) => im.run(m[0], m[1], m[2], m[2] === "owner" ? "u.admin" : m[0], now(), m[3]));

// ---------------------------------------------------------------- 群組能力
const gcaps = [
  ["g.platadmins", "view.audit"], ["g.platadmins", "export.audit"], ["g.platadmins", "manage.groups"],
  ["g.audit", "view.audit"], ["g.audit", "export.audit"],
  ["g.noc", "notify"],
];
const igc = ins("INSERT INTO group_capabilities(group_id,capability) VALUES(?,?)");
gcaps.forEach((c) => igc.run(...c));

// ---------------------------------------------------------------- Workspaces
const ws = [
  ["ws.mon.core", "核心監控", "monitoring", "核心系統即時監控", "g.monitoring", 0],
  ["ws.mon.alert", "告警中心", "incident", "告警規則與事件", "g.monitoring", 0],
  ["ws.mon.grafana", "Grafana 儀表板", "dashboard", "監控儀表板", "g.monitoring", 0],
  ["ws.plat.capacity", "容量管理", "capacity", "容量規劃", "g.plateng", 0],
  ["ws.plat.release", "發布管理", "release", "發布與變更", "g.plateng", 0],
  ["ws.app1.svc", "ERP 服務台", "monitoring", "應用一組服務", "g.app1", 0],
  ["ws.app1.inc", "ERP 事件流", "incident", "應用一組事件", "g.app1", 0],
  ["ws.app2.svc", "CRM 服務台", "monitoring", "應用二組服務", "g.app2", 0],
  ["ws.sre.core", "SRE 核心", "runbook", "Runbook / 演練", "g.sre", 0],
  ["ws.shared.noc", "全平台事件總覽", "incident", "跨單位事件總覽（共用）", "g.noc", 1],
];
const iw = ins("INSERT INTO workspaces(id,name,kind,description,owner_group_id,shared,sort) VALUES(?,?,?,?,?,?,?)");
ws.forEach((w, i) => iw.run(w[0], w[1], w[2], w[3], w[4], w[5], i));

// ---------------------------------------------------------------- ACL（群組 → workspace）
const acls = [
  ["a1", "ws.mon.core", "g.monitoring", "admin", null],
  ["a2", "ws.mon.alert", "g.monitoring", "admin", null],
  ["a3", "ws.mon.grafana", "g.monitoring", "admin", null],
  ["a4", "ws.plat.capacity", "g.plateng", "admin", null],
  ["a5", "ws.plat.release", "g.plateng", "admin", null],
  ["a6", "ws.app1.svc", "g.app1", "admin", null],
  ["a7", "ws.app1.inc", "g.app1", "admin", null],
  ["a8", "ws.app2.svc", "g.app2", "admin", null],
  ["a9", "ws.sre.core", "g.sre", "admin", null],
  ["a10", "ws.shared.noc", "g.noc", "admin", null],
  // NOC 共用總覽：讓其他單位「唯讀」看（示範跨群組授權）
  ["a11", "ws.shared.noc", "g.monitoring", "view", null],
  ["a12", "ws.shared.noc", "g.app1", "view", null],
  ["a13", "ws.shared.noc", "g.app2", "view", null],
  // 稽核臨時授權：監控組告警中心唯讀，4h TTL
  ["a14", "ws.mon.alert", "g.audit", "view", in4h],
];
const ia = ins("INSERT INTO workspace_acl(id,workspace_id,group_id,permission,granted_by,granted_at,expires_at,note) VALUES(?,?,?,?,?,?,?,?)");
acls.forEach((a) => ia.run(a[0], a[1], a[2], a[3], a[2] === "g.audit" ? "u.admin" : "u.admin", now(), a[4], a[4] ? "事件稽核臨時授權（4h）" : "常設"));

// ---------------------------------------------------------------- 資源
const res = [
  ["r1", "ws.mon.core", "service", "MES API Gateway", "g.monitoring", "Healthy"],
  ["r2", "ws.mon.core", "service", "Oracle RAC Cluster", "g.monitoring", "Warning"],
  ["r3", "ws.mon.core", "dashboard", "核心監控總表", "g.monitoring", "ok"],
  ["r4", "ws.mon.alert", "incident", "INC-2043 交易逾時", "g.monitoring", "Open"],
  ["r5", "ws.mon.alert", "incident", "INC-2041 批次延遲", "g.monitoring", "Resolved"],
  ["r6", "ws.plat.capacity", "report", "Q4 容量報告", "g.plateng", "ok"],
  ["r7", "ws.plat.release", "service", "CI/CD Pipeline", "g.plateng", "Healthy"],
  ["r8", "ws.app1.svc", "service", "ERP 前台", "g.app1", "Healthy"],
  ["r9", "ws.app1.inc", "incident", "INC-2050 ERP 登入慢", "g.app1", "Open"],
  ["r10", "ws.app2.svc", "service", "CRM 系統", "g.app2", "Warning"],
  ["r11", "ws.sre.core", "report", "SRE 演練報告", "g.sre", "ok"],
  ["r12", "ws.shared.noc", "incident", "INC-2043 交易逾時", "g.monitoring", "Open"],
  ["r13", "ws.shared.noc", "incident", "INC-2050 ERP 登入慢", "g.app1", "Open"],
];
const ir = ins("INSERT INTO resources(id,workspace_id,type,name,owner_group_id,status,updated_at) VALUES(?,?,?,?,?,?,?)");
res.forEach((r) => ir.run(r[0], r[1], r[2], r[3], r[4], r[5], now()));

// ---------------------------------------------------------------- 申請單（示範待審）
const reqs = [
  // 新進工程師申請加入監控組（待 王組長 審）
  ["q1", "u.newbie", "group", "g.monitoring", null, "member", "我新到職，想加入監控組", "pending", now()],
  // SRE 核心組申請「容量管理」唯讀（待 平台工程組 審）
  ["q2", "u.leadsre", "workspace", "ws.plat.capacity", "g.sre", "view", "要做容量相關的可靠性分析，需要唯讀", "pending", now()],
  // 觀察者申請加入應用二組 —— 已被核准（歷史）
  ["q3", "u.viewapp2", "group", "g.app2", null, "member", "需要看 CRM 服務狀態", "approved", now()],
];
const ireq = ins("INSERT INTO access_requests(id,requester_id,target_type,target_id,group_id,requested_role,reason,status,decided_by,decided_at,decision_note,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
reqs.forEach((q) => {
  const approved = q[7] === "approved";
  ireq.run(q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7], approved ? "u.leadapp2" : null, approved ? now() : null, approved ? "同意" : null, null, q[8]);
});

console.log("✅ seed 完成 →", DB_PATH);
console.log(`   人員 ${users.length} / 群組 ${groups.length} / 成員 ${members.length} / 能力 ${gcaps.length} / workspace ${ws.length} / ACL ${acls.length} / 資源 ${res.length} / 申請 ${reqs.length}`);
console.log("   示範帳號（密碼皆 demo123）：");
users.forEach((u) => console.log(`     ${u[1].padEnd(14)} → ${u[2]}`));
db.close();
