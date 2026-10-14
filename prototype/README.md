# SRE Platform — Organization & Access Prototype (SQLite)

用 SQLite 設計的**組織／權限 schema v1** + 一支**可跑的 prototype**：
從「一個人登入」開始，看他能看到哪些 **Workspace** —— 階層概念像 Azure。

## Azure 對照

| SRE Platform | Azure |
|---|---|
| 處 (Office) | Tenant |
| 部門 (Department) | Management Group |
| 課 (Section) | Subscription |
| Workspace | Resource Group |
| Resource (服務/事件/儀表板/報告) | Resource |

## 存取模型

```
可見 / 可做 = Capability(角色) ∩ DataScope(組織樹子樹) ∩ Action(授權動作)
```

- **Capability** — 由角色決定（能不能看到某功能頁）
- **DataScope** — 由組織樹推導（看得到「自己節點 + 子樹」的資料）
- **Action** — 在這筆資料上被授權做什麼
- 動態授權（值班 / 事件臨時 / 委派）用 `grants.expires_at` 做 TTL

## 跑起來

需求：**Node.js 22.5+**（用內建 `node:sqlite`，零外部依賴）

```bash
cd prototype
node seed.mjs      # 建 data.db + 灌示範資料
node server.mjs    # → http://localhost:5180
```

示範帳號（密碼皆 `demo123`）：

| 帳號 | 身分 | 會看到 |
|---|---|---|
| `admin` | 平台管理員 | 全部（含設定/稽核）|
| `chief.info` | 資訊處長 | 整個資訊處 rollup |
| `mgr.sysops` | 系統維運部主管 | 系統維運部底下所有課 |
| `lead.mon` | 監控課長 | 監控課 |
| `eng.mon` | 值班工程師 | 監控課（可執行，可開事件）|
| `eng.app1` | 應用一課工程師 | 應用一課 |
| `viewer.app2` | 觀察（唯讀）| 應用二課（只看）|
| `auditor` | 稽核/資安 | 跨單位唯讀 + 稽核日誌（含 4h 臨時授權示範 ⏱）|
| `noc.duty` | NOC 值班 | 全平台事件（共用 workspace）|

登入頁有快速切換按鈕，直接比較「同一頁、不同人看到不同資料」。

## 檔案

| 檔案 | 說明 |
|---|---|
| `schema.sql` | SQLite schema v1（組織樹 / 人員 / 角色 / 授權 / workspace / 資源 / 稽核 / session）|
| `seed.mjs` | 建庫 + 灌示範資料 |
| `server.mjs` | 零依賴 HTTP server + 存取解析（subtree scope / capability / audit）|
| `public/index.html` | 前端（Azure 式階層瀏覽 + 資源 + 稽核）|

## 這個 prototype 示範了什麼

1. **登入 → View Model**：算 capabilities / scope / roles（含 TTL 判定）
2. **Azure 式階層**：處 › 部門 › 課 › Workspace，沒權限的節點顯示 🔒
3. **同頁不同資料**：處長看全處、課長看全課、工程師只看自己課
4. **遮蔽講清楚**：`hiddenCount` → 「有 N 筆不在你資料範圍」，不靜默隱藏
5. **共用 workspace**：`shared` / `workspace_org_links` 讓跨單位資源可見（標「共用/關聯」）
6. **動態授權**：`auditor` 有一筆 4h TTL 的臨時授權
7. **稽核**：每次 login / view 都留痕，`view.audit` 才看得到

## 設計決策（預設；可調）

- 處 = 最高隔離單位；平台/稽核/高層可跨處（rollup）
- 資源有單一主責課 `owner_org_id`（多單位靠 workspace 關聯處理）
- 跨單位可見 = 靜態（shared/link）+ 動態（TTL grant）並存

## 下一步

- 接 **PAAW Policy Engine**（R6）當 resolver / 審批
- authZ filter 下沉到每個 API（本 prototype 已示範 workspaces/resources/audit 三處）
- Workspace 內資源 CRUD + 審批卡 + 不可變稽核（接 ES log pipeline）
