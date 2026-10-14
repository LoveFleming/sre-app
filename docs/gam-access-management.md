# SRE Platform — GAM 群組存取管理設計（v2，2026-10-14）

> 方向修正（Fleming）：**不管「處 / 部門」的固定組織樹**。改成 **GAM（Group Access Management）**：
> 各單位的人自己來「申請」，加入後由**該群組自己維護權限**。
> 定位仍是 platform level：一個人進來 SRE platform，能看到什麼功能、什麼資料。

---

## 0. 一句話

**權限不再來自「你在組織樹的哪一層」，而來自「你是哪些群組的成員」。**
群組是授權的最小單位；群組的 owner/manager 是它自己的管理員。

```
有效存取 = ∪ (我的群組 → 該群組被授權到的 Workspace，取最強權限)
         + ∪ (我的群組的群組層能力，如 view.audit / notify)
```

---

## 1. 為什麼不用組織樹

- 組織樹變動慢、跨單位協作（事件、專案、臨時支援）用樹表達很硬
- 「各單位自己申請、自己維護」= 去中心化：把權限管理下放給最懂的人
- 這正是 Google Workspace Groups / Azure AD Groups / AWS IAM Identity Center 群組 的做法

---

## 2. 核心物件

| 物件 | 角色 | 誰維護 |
|---|---|---|
| **群組（Group）** | 授權單位（unit / service / committee / shared）| 群組自己的 owner/manager |
| **成員（Member）** | 人在群組裡的角色：owner / manager / member | 群組 owner/manager |
| **Workspace** | 存取標的（監控/事件/儀表板/runbook…），歸屬一個主責群組 | 主責群組 |
| **ACL（群組 → Workspace）** | 該群組對該 workspace 的權限：view / operate / approve / admin | 群組 owner/manager |
| **申請（Access Request）** | ① 申請加入群組 ② 用某群組申請 workspace 存取 | 申請人發起；目標 owner 審 |
| **能力（Capability）** | 由權限推導：view→view.*；operate→run.inspection/open.incident；approve；admin→configure | 系統推導 |
| **群組層能力** | 跨 workspace 的（view.audit / notify / manage.groups）| 平台/群組 owner |

---

## 3. 三種權限角色（群組內）

- **owner** — 全權：審申請、加減成員、授權 workspace、改設定
- **manager** — 審申請、加減成員（不能刪群組）
- **member** — 只是成員，繼承群組的 workspace 權限

## 4. 四級 Workspace 權限（群組 → workspace）

| 權限 | 意義 | 推導能力 |
|---|---|---|
| `view` | 唯讀 | 看總覽/事件 |
| `operate` | 可操作 | + 執行巡檢、開事件、看 Grafana |
| `approve` | 可審批 | + 審批卡 |
| `admin` | 可管理 | + 設定、管理 ACL |

> 同一個 workspace，使用者若屬多個被授權群組 → 取**最強**那個。

---

## 5. 申請 → 審核流程（自助）

```
① 加入群組
   申請人 ──申請──▶ 群組 pending ── owner/manager 核准 ──▶ 成為 member  ──▶ 立刻繼承該群組的 workspace 權限
   （join_policy = open 時自動核准；invite 則需邀請）

② 群組申請 workspace 存取
   群組 owner（代表群組）──申請 view/operate/…──▶ 該 workspace 的 admin 群組 owner 審 ──核准──▶ 建立 workspace_acl
```

- 申請都會留痕（誰申請、誰核准、理由）
- 核准後可設 **TTL**（臨時支援 / 借調）

---

## 6. 動態例外

| 情境 | 做法 |
|---|---|
| 事件臨時支援 | 給某群組一筆 `workspace_acl(..., expires_at)` |
| 跨單位借調 | `group_members(..., expires_at)` 到期自動失效 |
| open 群組 | `join_policy='open'` 免審直接加入 |
| 平台管理 | `is_platform_admin`（極少數，bootstrap / 安全）|

> 鐵則：**動態授權一律 TTL + 稽核 + 可回看。**

---

## 7. 三層強制（縱深防禦）

1. **UI** — 依「我的存取 / 我的群組」投影，看不到的不顯示
2. **API** — 每個 endpoint 在 server 端重驗（`myWorkspaces()` / `canManage()`）
3. **Data** — 查詢一律帶 scope（只撈有權限的）

敏感動作（授權、加成員、審批）→ 審批 + **不可變稽核**（可接 ES log pipeline）。

---

## 8. 資料模型（SQLite v2）

```
users(id, username, password_hash, display_name, title, is_platform_admin, source)
groups(id, name, slug, kind, description, parent_group_id?, join_policy, created_by, created_at)
group_members(group_id, user_id, member_role[owner|manager|member], status, added_by, joined_at, expires_at)
group_capabilities(group_id, capability)
workspaces(id, name, kind, description, owner_group_id, shared, sort)
workspace_acl(id, workspace_id, group_id, permission[view|operate|approve|admin], granted_by, granted_at, expires_at, note)
resources(id, workspace_id, type, name, owner_group_id, status, updated_at)
access_requests(id, requester_id, target_type[group|workspace], target_id, group_id?, requested_role, reason, status, decided_by, decided_at, decision_note, expires_at, created_at)
audit_log(id, ts, user_id, action, target, detail, result)
sessions(token, user_id, created_at, expires_at)
```

可跑 prototype：`prototype/`（`node seed.mjs` → `node server.mjs` → http://localhost:5180）

---

## 9. 分期

- **R1（已做）**：群組 + 成員 + ACL + 申請/審核 + 我的存取 + 稽核
- **R2**：審批卡 / 敏感動作二次確認、群組巢狀整理、SSO/AD 群組同步
- **R3**：動態（TTL grant 全面化、on-call 輪值、break-glass）
- **R4**：平台層跨群組彙總 + 政策引擎（PAAW R6）+ 稽核匯出

---

## 10. 待 Fleming 拍板

1. **申請粒度**：只有「加入群組」一種，還是也開放「直接申請某 workspace」（用個人身分）？
2. **群組能否巢狀繼承權限**：目前巢狀只是「整理」，**不繼承**權限 —— 要繼承嗎？
3. **誰能建群組**：所有人可自建？或需平台管理核准？
4. **審核 SLA**：多久沒審自動提醒 / 逾期自動拒絕？
5. **帳號來源**：AD/SSO 是否同步群組成員？或純平台自管？
6. **命名**：對外叫「群組 / Group / Team」要統一
