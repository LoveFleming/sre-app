/**
 * seed.mjs — 建立 SQLite 資料庫 + 灌示範資料（SRE 平台組織/權限 prototype v1）
 *
 * 用法： node seed.mjs            → 重建 data.db
 *        node seed.mjs --keep     → 不重建，只補（略）
 *
 * 依 schema.sql 建表；灌：組織樹(處/部門/課) + 角色 + 人員 + 授權(含 TTL) +
 * workspaces + 資源 + 稽核空表。密碼一律 demo123（sha256）。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "data.db");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const PWD = sha("demo123");

if (existsSync(DB_PATH)) rmSync(DB_PATH);
const db = new DatabaseSync(DB_PATH);
db.exec(readFileSync(join(__dirname, "schema.sql"), "utf-8"));

// ---------------------------------------------------------------- 組織樹
// 類比 Azure：platform(Tenant 根) → 處 → 部門 → 課
const orgs = [
  ["platform", null, "platform", "SRE Platform", "/"],

  ["info", "platform", "office", "資訊處", "/info"],
  ["info.sysops", "info", "department", "系統維運部", "/info/sysops"],
  ["info.sysops.monitoring", "info.sysops", "section", "監控課", "/info/sysops/monitoring"],
  ["info.sysops.platform", "info.sysops", "section", "平台課", "/info/sysops/platform"],
  ["info.appops", "info", "department", "應用維運部", "/info/appops"],
  ["info.appops.app1", "info.appops", "section", "應用一課", "/info/appops/app1"],
  ["info.appops.app2", "info.appops", "section", "應用二課", "/info/appops/app2"],

  ["rd", "platform", "office", "研發處", "/rd"],
  ["rd.sre", "rd", "department", "SRE 部", "/rd/sre"],
  ["rd.sre.core", "rd.sre", "section", "核心工程課", "/rd/sre/core"],
];
const insOrg = db.prepare("INSERT INTO org_units(id,parent_id,level,name,path,sort) VALUES(?,?,?,?,?,?)");
orgs.forEach((o, i) => insOrg.run(o[0], o[1], o[2], o[3], o[4], i));

// ---------------------------------------------------------------- 角色
const roles = [
  ["platform.admin", "平台管理員", 0, "平台全權（含設定）"],
  ["office.chief", "處長", 1, "全處 rollup"],
  ["dept.manager", "部門主管", 2, "該部下所有課"],
  ["section.lead", "課長", 3, "該課（含課內設定/審批）"],
  ["engineer.oncall", "值班工程師", 3, "該課：巡檢/事件/操作"],
  ["engineer.maint", "維護工程師", 3, "該課：巡檢/編輯 runbook"],
  ["viewer", "觀察（唯讀）", 3, "對應範圍唯讀"],
  ["auditor", "稽核/資安", 9, "跨單位唯讀（含 audit log）"],
  ["noc", "值班中心 NOC", 9, "跨單位事件唯讀 + 通報"],
];
const insRole = db.prepare("INSERT INTO roles(key,name,level_rank,description) VALUES(?,?,?,?)");
roles.forEach((r) => insRole.run(...r));

const READ = ["view.overview", "view.inspections", "view.grafana", "view.incidents", "view.agents"];
const caps = {
  "platform.admin": [...READ, "run.inspection", "open.incident", "approve", "configure.platform", "view.audit", "manage.users"],
  "office.chief": [...READ, "run.inspection", "open.incident", "approve", "configure.office", "view.rollup"],
  "dept.manager": [...READ, "run.inspection", "open.incident", "approve", "configure.dept", "view.rollup"],
  "section.lead": [...READ, "run.inspection", "open.incident", "approve", "configure.section"],
  "engineer.oncall": [...READ, "run.inspection", "open.incident"],
  "engineer.maint": [...READ, "run.inspection", "edit.runbook"],
  viewer: ["view.overview", "view.incidents"],
  auditor: ["view.overview", "view.incidents", "view.audit", "export.audit"],
  noc: ["view.overview", "view.incidents", "notify"],
};
const insCap = db.prepare("INSERT INTO role_capabilities(role_key,capability) VALUES(?,?)");
for (const [rk, list] of Object.entries(caps)) for (const c of list) insCap.run(rk, c);

// ---------------------------------------------------------------- 人員
const users = [
  ["u.admin", "admin", "平台管理員 Adam", "info.sysops.platform", "平台工程師"],
  ["u.chief", "chief.info", "陳處長", "info", "資訊處長"],
  ["u.mgr", "mgr.sysops", "林部長", "info.sysops", "系統維運部主管"],
  ["u.lead", "lead.mon", "王課長", "info.sysops.monitoring", "監控課長"],
  ["u.eng", "eng.mon", "李工程師", "info.sysops.monitoring", "值班工程師"],
  ["u.eng2", "eng.app1", "張工程師", "info.appops.app1", "應用一課工程師"],
  ["u.view", "viewer.app2", "吳觀察", "info.appops.app2", "觀察者"],
  ["u.audit", "auditor", "資安稽核", "rd.sre.core", "資安稽核員"],
  ["u.noc", "noc.duty", "NOC 值班", "info.sysops.monitoring", "值班中心"],
];
const insUser = db.prepare("INSERT INTO users(id,username,password_hash,display_name,email,org_unit_id,title,source) VALUES(?,?,?,?,?,?,?,?)");
users.forEach((u) => insUser.run(u[0], u[1], PWD, u[2], `${u[1]}@example.com`, u[3], u[4], "local"));

// ---------------------------------------------------------------- 授權
// expires_at 非 NULL = 動態（TTL）：示範「事件臨時授權」
const in4h = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
const grants = [
  ["g1", "u.admin", "platform.admin", "platform", null, now(), null, "常設"],
  ["g2", "u.chief", "office.chief", "info", null, now(), null, "常設"],
  ["g3", "u.mgr", "dept.manager", "info.sysops", null, now(), null, "常設"],
  ["g4", "u.lead", "section.lead", "info.sysops.monitoring", null, now(), null, "常設"],
  ["g5", "u.eng", "engineer.oncall", "info.sysops.monitoring", "u.lead", now(), null, "常設"],
  ["g6", "u.eng2", "engineer.oncall", "info.appops.app1", "u.mgr", now(), null, "常設"],
  ["g7", "u.view", "viewer", "info.appops.app2", "u.mgr", now(), null, "常設"],
  ["g8", "u.audit", "auditor", "platform", null, now(), null, "常設"],
  ["g9", "u.noc", "noc", "platform", null, now(), null, "常設"],
  // 事件臨時授權：資安稽核被臨時授予監控課工程師權限（4h TTL）
  ["g10", "u.audit", "engineer.maint", "info.sysops.monitoring", "u.admin", now(), in4h, "事件 INC-2043 臨時支援（4h）"],
];
const insGrant = db.prepare("INSERT INTO grants(id,user_id,role_key,org_unit_id,granted_by,granted_at,expires_at,note) VALUES(?,?,?,?,?,?,?,?)");
grants.forEach((g) => insGrant.run(...g));

// ---------------------------------------------------------------- Workspaces
const ws = [
  ["ws.mon.core", "info.sysops.monitoring", "核心監控", "monitoring", "核心系統即時監控", 0],
  ["ws.mon.alert", "info.sysops.monitoring", "告警中心", "incident", "告警規則與事件", 0],
  ["ws.mon.grafana", "info.sysops.monitoring", "Grafana 儀表板", "dashboard", "監控儀表板", 0],
  ["ws.plat.capacity", "info.sysops.platform", "容量管理", "capacity", "容量規劃", 0],
  ["ws.plat.release", "info.sysops.platform", "發布管理", "release", "發布與變更", 0],
  ["ws.app1.svc", "info.appops.app1", "應用一課服務台", "monitoring", "應用一課服務", 0],
  ["ws.app1.inc", "info.appops.app1", "應用一課事件", "incident", "應用一課事件流", 0],
  ["ws.app2.svc", "info.appops.app2", "應用二課服務台", "monitoring", "應用二課服務", 0],
  ["ws.rd.core", "rd.sre.core", "SRE 核心", "runbook", "Runbook / 演練", 0],
  ["ws.shared.noc", "platform", "全平台事件總覽", "incident", "跨單位事件總覽（共用）", 1],
];
const insWs = db.prepare("INSERT INTO workspaces(id,org_unit_id,name,kind,description,shared,sort) VALUES(?,?,?,?,?,?,?)");
ws.forEach((w, i) => insWs.run(...w, i));

// 共用 workspace 的關聯單位
const insLink = db.prepare("INSERT INTO workspace_org_links(workspace_id,org_unit_id,relationship) VALUES(?,?,?)");
insLink.run("ws.shared.noc", "info", "shared");
insLink.run("ws.shared.noc", "rd", "shared");

// ---------------------------------------------------------------- 資源
const res = [
  ["r1", "ws.mon.core", "service", "MES API Gateway", "info.sysops.monitoring", "Healthy"],
  ["r2", "ws.mon.core", "service", "Oracle RAC Cluster", "info.sysops.monitoring", "Warning"],
  ["r3", "ws.mon.core", "dashboard", "核心監控總表", "info.sysops.monitoring", "ok"],
  ["r4", "ws.mon.alert", "incident", "INC-2043 交易逾時", "info.sysops.monitoring", "Open"],
  ["r5", "ws.mon.alert", "incident", "INC-2041 批次延遲", "info.sysops.monitoring", "Resolved"],
  ["r6", "ws.plat.capacity", "report", "Q4 容量報告", "info.sysops.platform", "ok"],
  ["r7", "ws.plat.release", "service", "CI/CD Pipeline", "info.sysops.platform", "Healthy"],
  ["r8", "ws.app1.svc", "service", "ERP 前台", "info.appops.app1", "Healthy"],
  ["r9", "ws.app1.inc", "incident", "INC-2050 ERP 登入慢", "info.appops.app1", "Open"],
  ["r10", "ws.app2.svc", "service", "CRM 系統", "info.appops.app2", "Warning"],
  ["r11", "ws.rd.core", "report", "SRE 演練報告", "rd.sre.core", "ok"],
  ["r12", "ws.shared.noc", "incident", "INC-2043 交易逾時", "info.sysops.monitoring", "Open"],
  ["r13", "ws.shared.noc", "incident", "INC-2050 ERP 登入慢", "info.appops.app1", "Open"],
];
const insRes = db.prepare("INSERT INTO resources(id,workspace_id,type,name,owner_org_id,status,tags,updated_at) VALUES(?,?,?,?,?,?,?,?)");
res.forEach((r) => insRes.run(r[0], r[1], r[2], r[3], r[4], r[5], "[]", now()));

console.log("✅ seed 完成 →", DB_PATH);
console.log(`   組織 ${orgs.length} / 角色 ${roles.length} / 人員 ${users.length} / 授權 ${grants.length} / workspace ${ws.length} / 資源 ${res.length}`);
console.log("   示範帳號（密碼皆 demo123）：");
users.forEach((u) => console.log(`     ${u[1].padEnd(14)} → ${u[2]}`));
db.close();
