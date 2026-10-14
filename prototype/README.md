# SRE Platform — GAM Prototype (SQLite)

**GAM（Group Access Management）** 的 SQLite schema + 可跑 prototype：
從「一個人登入」開始，看他能看到哪些 **Workspace**；沒有的可以**申請**；群組 owner/manager **自己維護權限**。

> 不再用「處 → 部門 → 課」組織樹。權限來自 **你是哪些群組的成員**。

## 存取模型

```
有效存取 = ∪ (我的群組 → 該群組被授權到的 Workspace，取最強權限)
         + ∪ (我的群組的群組層能力，如 view.audit / notify)
```

- 群組內角色：`owner` / `manager` / `member`
- Workspace 權限（群組→workspace）：`view` / `operate` / `approve` / `admin`
- 申請：① 加入群組 ② 用你的群組申請 workspace 存取 → 由目標 owner 審
- 動態：`expires_at` 做 TTL（事件臨時 / 借調）

## 跑起來

需求：**Node.js 22.5+**（內建 `node:sqlite`，零外部依賴）

```bash
cd prototype
node seed.mjs      # 建 data.db + 灌示範資料
node server.mjs    # → http://localhost:5180
```

示範帳號（密碼皆 `demo123`）：

| 帳號 | 身分 | 看得到 |
|---|---|---|
| `admin` | 平台管理員 | 全部（含稽核）|
| `lead.mon` | 監控組 owner | 監控組工作站 + **可審申請 / 維護 ACL** |
| `eng.mon` | 監控組成員 | 監控組工作站 |
| `lead.plat` | 平台工程組 owner | 容量/發布 + 審 workspace 存取申請 |
| `lead.app1` | 應用一組 owner | ERP 工作站 |
| `auditor` | 稽核組 owner | 唯讀 + 稽核日誌（+4h 借調值班中心）|
| `newbie` | 新人（無群組）| 只有共用總覽；**已送加入監控組申請** |

登入頁可快速切換身分。**試一段完整流程**：
1. `newbie` 登入 → 我的存取只有「全平台事件總覽」
2. `lead.mon` 登入 → 管理群組 → 看到王小新的加入申請 → 核准
3. `newbie` 再看 → 多了監控組的 3 個工作站
4. `lead.sre` 申請「容量管理」唯讀 → `lead.plat` 審 → 通過後 SRE 就有唯讀

## 檔案

| 檔案 | 說明 |
|---|---|
| `schema.sql` | SQLite schema v2（GAM：groups / members / group_capabilities / workspaces / workspace_acl / resources / access_requests / audit / sessions）|
| `seed.mjs` | 建庫 + 灌示範資料（含待審申請、TTL 授權）|
| `server.mjs` | 零依賴 HTTP server + 存取解析（myWorkspaces / canManage / capabilities / audit）|
| `public/index.html` | 前端（我的存取 / 探索申請 / 我的群組 / 管理群組 / 稽核）|

## 這個 prototype 示範了什麼

1. 登入 → 我的存取（依群組授權推導，取最強權限）
2. 探索 / 申請：加入群組、用群組申請 workspace 存取
3. 管理群組（owner/manager）：審加入申請、審存取申請、加減成員、授權/回收 workspace（可 TTL）
4. 授權後**立刻生效**（newbie 核准後就多 3 個工作站）
5. 動態：成員/ACL 的 `expires_at` TTL（稽核組借調值班中心 4h）
6. 稽核：申請 / 核准 / 授權 / 瀏覽 全留痕，需 `view.audit`
7. server 端每個 API 重驗（`eng.mon` 想管別人的群組 → 403）

## 下一步

- 審批卡 / 敏感動作二次確認；群組巢狀繼承（若 Fleming 要）
- SSO/AD 群組同步；接 PAAW Policy Engine
- authZ filter 下沉到資源 CRUD；稽核接 ES log pipeline
