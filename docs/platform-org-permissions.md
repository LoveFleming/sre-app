# SRE Platform — 組織／權限架構設計（v0.1 草案，2026-10-14）

> 定位：**Platform level 產品**。不是給單一團隊用的工具，而是「一個組織（公司/機構）的 SRE 工作平台」。
> 核心問題一句話：**一個人進來 SRE platform，能看到什麼「功能」、什麼「資料」？**

---

## 0. 一句話設計哲學

**功能看「你是誰（角色）」，資料看「你在哪（組織位置）」，動作看「你被授權做什麼」。**
三者獨立正交，任何一次存取 = 三個條件的交集。

```
可見 / 可做 = Capability(角色)  ∩  DataScope(組織樹位置)  ∩  Action(授權動作)
```

- 「看得到功能頁」≠「看得到裡面的資料」——同一個「異常事件」頁，處長看到全處、課長看到全課、工程師只看到自己課。
- **UI 只是投影**；真正的開關一律在 server side 強制（UI 藏起來 ≠ 安全）。

---

## 1. 組織模型（Org Tree）

單一樹，三層，每層都是一個「權限節點 / 資料邊界」：

```
處 (Office, L1)          ← 最高隔離單位（tenant-like）
└── 部門 (Department, L2)
    └── 課 (Section, L3) ← 最小歸屬單位（前線工程師掛這裡）
```

- 每個節點有：`id, parentId, level, name, path`（path 像 `/info/sysops/monitoring`，方便子樹查詢）
- **人在「課」上**（principal.orgUnitId = 課），上面兩層靠樹自動推導
- 每個人有 `title`（職稱）+ **一個或多個 role**（見 §3）綁在節點上

> 設計要點：**組織樹 = 資料範圍的來源。** 不要另外維護一份「可見清單」，範圍一律由樹推導，才不會分岔。

---

## 2. 三個正交軸（存取三條件）

### 軸 A — Capability（功能可見）
「這個人能不能看到 / 用這個功能。」
- 例：總覽、自動巡檢、Grafana 監控、異常事件、AI Agent 工作區、設定
- 每個功能可再細分 action：`view / runInspection / openIncident / approve / configure / export`
- 由角色決定（§3），並由 capability manifest 餵給前端 nav

### 軸 B — DataScope（資料可見）
「這個人能看到哪些**資源**。」
- 資源（Resource）：受監控服務、事件、儀表板、巡檢結果、報告/Dossier、audit log…
- 每個資源有 **主責單位** `ownerOrgId`（哪個課負責）+ 可選 `relatedOrgIds[]`（共用/關聯單位）
- 可見規則（預設）：**看得到「自己節點 + 子樹」擁有的資源**
  - 工程師（課）→ 自己課
  - 課長 → 整課（含子？課通常無子）
  - 部長 → 整個部門下所有課
  - 處長 → 整個處
  - 平台/高層 → 跨處彙總（rollup，通常去識別化）

### 軸 C — Action（動作授權）
「在這筆資料上，你能做什麼。」
- `read / execute / edit / approve / delete / configure`
- 敏感動作（改設定、刪資源、下破壞性指令、對外通報）→ 需**審批 + 稽核**
- 同一個 role 在不同資源類型上可有不同 action set

---

## 3. 角色目錄（Role Catalog）

角色綁在「層級」，不是綁在人（人離職/調動只改綁定）。

| Role key | 名稱 | 綁定層 | 看資料範圍 | 典型 Capability |
|---|---|---|---|---|
| `platform.admin` | 平台管理員 | 平台 | 全部（含設定） | 全功能 + 平台設定 |
| `office.chief` | 處長 | 處 | 全處 rollup | 全功能（設定限處內）|
| `dept.manager` | 部門主管 | 部門 | 該部下全部課 | 全功能（唯讀跨課設定）|
| `section.lead` | 課長 | 課 | 該課 | 全功能 + 課內設定 + 審批 |
| `engineer.oncall` | 值班工程師 | 課 | 該課 | 巡檢/事件/操作（依指派的服務）|
| `engineer.maint` | 維護工程師 | 課 | 該課 | 巡檢/編輯 runbook/設定建議 |
| `viewer` | 觀察（唯讀） | 課/部/處 | 對應範圍 | 只看，不能動 |
| `auditor` | 稽核/資安 | 跨單位 | 唯讀（含 audit log）| 檢視 + 匯出稽核 |
| `noc` | 值班中心 NOC/SOC | 跨單位 | 跨單位「事件」唯讀 + 通報 | 事件檢視/通報 |

- 一個人可同時有多個 role（例：課長 + 值班工程師）
- 有效權限 = **所有 role 的聯集**，但任何 `deny` 一律勝出

---

## 4. 可見性解析（Effective Access Resolver）

一個人登入後，平台算出一份 **View Model**，前端照它畫：

```
1. identity        → 取得 orgUnit(path) + 所有 role 綁定
2. capabilities    → union(role.capabilities) 展開到子樹 → 決定「看得到哪些頁/動作」
3. dataScope(s)    → union(role 綁定節點的子樹) → set of org subtree
4. resources       → filter: resource.ownerOrgId ∈ dataScope
                              OR resource.relatedOrgIds ∩ dataScope ≠ ∅
                              OR resource.shared == true
5. actions         → for each resource: actionAllowed(role, resource.type, resource.ownerOrg)
6. UI              → nav 依 capabilities；頁內資料依 resources；按鈕依 actions
```

**關鍵 UX 細節：**
- 沒有 capability → 該 nav item 不出現
- 有 capability 但 scope 內沒資料 → 顯示「空狀態 + 原因」（例：「你負責的課目前沒有服務」），**不要讓使用者以為系統壞了**
- 被遮蔽的資料 → 顯示「有 N 筆你無權檢視」，而不是靜默隱藏（資訊透明度）

---

## 5. 動態例外（SRE 的真實需求）

純靜態 RBAC 不夠 —— 真實 SRE 有幾個必須處理的動態情境：

1. **事件升級臨時擴大範圍 (Incident-scoped TTL grant)**
   事故發生時，跨單位需要看相關服務。→ 開事件時，事件指揮官可**臨時授權**相關單位 TTL（如 4h）唯讀該事件關聯資源，到期自動收回。
2. **On-call 輪值**
   值班是「時間 × 人」的授權。→ 輪值表產生**期間性 grant**，下班自動失效。
3. **Break-glass（緊急提權）**
   半夜沒人審批時，允許自助提權，但**強制留痕 + 事後回顧 + 通知主管**。
4. **委派 (Delegation)**
   課長請假，把審批權暫時委派給代理人，到期自動還原。

> 原則：**動態授權一定要有 TTL + 稽核 + 可回看**，否則等於開後門。

---

## 6. 三層強制（縱深防禦）

| 層 | 做什麼 | 為什麼 |
|---|---|---|
| L1 UI | nav / 頁 / 按鈕依 View Model 投影 | 好用、不誤導 |
| L2 API (server) | **每個 endpoint 自己再驗一次** capability + scope | UI 藏起來不等於安全 |
| L3 Data | 查詢一律帶 scope filter（不 select 不該看的）| 防止越權查詢 / 匯出外洩 |

- 敏感動作 → **審批卡 + 不可變稽核**（可接 PAAW 的 ES log pipeline）
- 稽核紀錄：誰、何時、看了/做了什麼、依據哪個 grant

---

## 7. 與 PAAW 的關係（這是一個 PAAW 產品）

- **sre-app**（standalone React app）= 這個 platform 的前端載體；用 PAAW coding app 開發
- **每個處 = 一組 crews**（SRE 職能：chief/incident/runbook/slo/grafana/postmortem/capacity/release…），綁在組織節點上
- **Policy Engine**（PAAW R6 的那個）→ 正好當 §4 的 resolver + §5 的動態授權
- 組織樹 / 授權資料 = **platform data**（各機自帶，不隨碼出走）

---

## 8. 資料模型草案

```
org_units(id, parent_id, level, name, path)
principals(id, display_name, org_unit_id, title, source /*AD/SSO/local*/)
roles(key, name, level, description)
role_capabilities(role_key, capability_key, action_set)
grants(id, subject /*principal|group*/, role_key, org_unit_id,
       granted_by, granted_at, expires_at /*null=常設*/)
resources(id, type, owner_org_id, related_org_ids[], shared, tags)
resource_actions_catalog(resource_type, action_key, min_role_level, requires_approval)
audit_log(ts, actor, action, resource, grant_used, result)
```

- `grants.expires_at` = null → 常設（職務）；非 null → 動態（值班/TTL/委派）
- 資源查詢：`owner_org_id IN (subtree of scope) OR related ∩ scope`

---

## 9. 分期實作

- **R1 靜態骨架**：組織樹 + role + 子樹資料 filter + nav capability 投影（先讓「看到什麼」成立）
- **R2 動作與審批**：action 授權 + 審批卡 + 稽核（閱讀 → 可執行 → 可審批）
- **R3 動態例外**：on-call 輪值 grant + incident TTL + break-glass + 委派
- **R4 平台層彙總 + 政策引擎**：跨處 rollup 儀表板、ABAC 政策、資安/稽核視圖與匯出

---

## 10. 待 Fleming 拍板的設計決策

1. **處 = 隔離邊界？** 處與處之間完全看不到彼此，還是平台/高層能跨處 rollup？
2. **資源歸屬**：一個服務只有「一個主責課」，還是允許「共用/多單位關聯」？（影響 §2-B 的 filter）
3. **跨單位可見**：預設「靜態常設」還是「事件期間臨時」？（影響 §5 的複雜度）
4. **帳號來源**：公司 AD / SSO 是否帶組織資訊？還是平台自己維護組織樹？（影響同步策略）
5. **稽核視圖給誰**：資安單位？還是各處也各自能看自己的稽核？
6. **「處」的英文/對外命名**：Office / Division / Department → 對外文件一致性
