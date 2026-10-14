# SRE Agentic App — K8s 部署架構（v2 最單純安全版）

> 2026-10-14 Fleming：**不開任何 k8s Job**，要最單純又安全的架構。
> 需求：web ui / app server(agent runtime) / mcp server / postgresql，
> 很多 circle group 的人來用，batch 工作也多。

## 0. 一句話

**全部都是長跑的 Deployment，叢集裡沒有任何會被「動態產生／消滅」的資源。**
Batch 不是 Job，是「佇列 + 常駐 worker」。這同時是最單純（調度零變化）
也是最安全（api / worker 完全不需要 k8s API 權限）的做法。

## 1. 設計原則

1. **只有 Deployment / StatefulSet / Service / Ingress / NetworkPolicy** —— 沒有 Job、沒有 CronJob 產資源。
2. **誰需要權限，就只有那個 pod 有**：只有 `mcp-k8s` 拿 kubeconfig，agent runtime 本身沒有任何 k8s 憑證。
3. **無狀態化**：api / worker 不存 session、不存檔，全部外部化到 Postgres / 物件儲存。
4. **長工作不進請求路徑**：打字走 SSE 幾秒回；掃描 / 報表 / 批次一律進 queue。
5. **預設拒絕**：NetworkPolicy 一律 default-deny，只開必要的方向。

**排程型工作怎麼辦？** 不用 CronJob —— 用 DB 驅動排程：`scheduled_jobs` 表存下次執行時間，
worker 內建一個每分鐘的小 loop 把到期的排進 `jobs`。叢集資源零變化，行為可稽核。

## 1.5 三層式本體（SRE agentic web app）

| 層 | 內容 | 通訊 |
|---|---|---|
| **1. Web AP（呈現層）** | `web`：SPA（nginx）+ `api` 的 `/api` 反向代理 | 只有這層對外（Ingress） |
| **2. Application（執行層）** | `api`（agent runtime + SSE 串流）、`mcp-*`（工具）、`worker`（queue 消費者） | 純內網 |
| **3. Data（資料層）** | `pgbouncer` → `postgres`（含 `jobs` queue 表、GAM、audit） | 純內網，**只有 pgbouncer 能連 postgres** |

**對照雲端 PAAW 的四部分：**

| 雲端 PAAW | SRE agentic web app |
|---|---|
| Web AP | 層 1：Web AP |
| EM 協調執行器 | 層 2：`api`（agent runtime） |
| Coding 執行環境 | **無** —— 見下 |
| 持久化資料 | 層 3：`postgres` |
| （工具） | 層 2：`mcp-*`（SRE 把工具獨立成微服務） |

**為什麼 SRE app 三層就夠、不需要「Coding 執行環境」：**
PAAW 的 agent 要**寫程式、跑 build、開 terminal**，所以需要一個獨立的沙箱執行環境；
SRE app 的 agent 只做「讀 / 查 / 關聯 / 開單 / 通知」，全部透過 `mcp-*` 工具服務完成，
不需要在叢集裡跑使用者產生的程式碼 → **少一層，也少一整個最大攻擊面**。

## 2. 元件（就這 7 個）

| 元件 | 型態 | 數量 | 對外 |
|---|---|---|---|
| `web` | Deployment（nginx + SPA） | 2+ | Ingress |
| `api` | Deployment（agent runtime、SSE） | 3+ | Ingress `/api` |
| `worker` | Deployment（吃 queue 跑長工作） | 2+（KEDA 擴） | 無 |
| `mcp-k8s` | Deployment | 1 | ClusterIP |
| `mcp-<其他>` | Deployment（ES / Grafana / …） | 各 1 | ClusterIP |
| `pgbouncer` | Deployment | 2 | ClusterIP |
| `postgres` | StatefulSet（或 operator） | 1 primary(+replica) | ClusterIP |

**Queue 不另外裝**：直接用 Postgres 的 `jobs` 表 + `FOR UPDATE SKIP LOCKED`。
少一個元件 = 少一個故障點、少一份要備份的東西。

## 3. 拓撲

```
              Internet
                 │
           ┌─────┴─────┐
           │  Ingress  │  (nginx / TLS)
           └──┬─────┬──┘
        /     │     │      (只有 web 與 /api 對外)
   ┌────┴──┐  │  ┌──┴──────┐
   │  web  │  │  │   api   │   agent runtime（SSE）
   └───────┘  │  └─┬──┬──┬─┘
              │    │  │  └────────────┐
              │    │  └───────┐       │
              │ ┌──┴──────┐ ┌─┴────┐ ┌┴────────┐
              │ │  queue  │ │mcp-* │ │pgbouncer│
              │ │ (jobs表)│ └──────┘ └──┬──────┘
              │ └──┬──────┘     ▲       │
              │    │            │       │
              │ ┌──┴──────┐     │  ┌────┴─────┐
              └▶│ worker  │─────┘  │ postgres │
                └─────────┘        └──────────┘
```

箭頭方向 = NetworkPolicy 允許方向；其餘一律 deny。

## 4. Batch：常駐 worker pool（不是 Job）

- `jobs` 表：`id, group_id, type, payload, status, lease_until, attempts, created_at`
- worker 迴圈：`SELECT ... WHERE status='queued' FOR UPDATE SKIP LOCKED LIMIT n`
  → 標 `running` + 設 `lease_until` → 執行 → 寫結果 + `audit_log`
- **worker 掛掉**：lease 過期 → 別的 worker 自動接手（不用 k8s 幫你重生 Job）
- **公平性**：每個 circle group 設 `max_concurrent`，取 job 時跳過已達上限的 group
  → 一個大 group 不會餓死其他 group
- **重試**：`attempts < N` 才回 queue，否則 `failed`（失敗也要留 audit）
- **排程**：worker 內建每分鐘 loop 掃 `scheduled_jobs` 到期 → 塞進 `jobs`

**為什麼這比 k8s Job 好（而且是你要的「單純安全」）：**
1. 叢集資源零變化 —— 沒有 Job 生成/GC/垃圾堆積問題
2. api / worker **不需要 k8s API 權限** → 就算 agent 被 prompt injection 攻破也影響不到叢集
3. 可觀測：job 狀態在 DB 裡，一個 SQL 就看完全部
4. 可精準控流：併發、配額、重試、優先序全在程式裡，不用跟 k8s 調度器搏鬥

## 4.5 大量長跑巡檢 job：pod 數不會爆

**關鍵：一個 worker pod 同時跑 N 個 job。**
agent 工作是 **I/O-bound**（大部分時間在等 LLM / API 回應，不是 CPU），
所以單一 worker pod 併發 20~50 個 job 很正常。

- 1000 個巡檢 job **≠ 1000 個 pod**；是「queue 1000 筆 + 20~30 個 worker pod」
- KEDA 依 queue 深度擴縮，但**一定要設 `maxReplicas` 上限** → pod 數有界，不會爆
- 用 `resources.requests/limits` 把每個 pod 的記憶體框住（每個 in-flight job 都要吃一點）

**長跑 job 紀律（不然會卡死或漏單）：**
- `lease_until` + **心跳續租**（worker 每 30s 更新）→ worker 掛掉自動被別的 worker 接手
- `max_runtime` + timeout → 不讓一個 job 永久占位
- **別在 job 全程握著 DB 連線**：pgbouncer transaction pooling，每次查詢 acquire/release
- **進度寫 DB**（`job_events`）；**長工作不要用 SSE 撐著** —— SSE 是聊天用的，
  巡檢用「DB 狀態 + UI 輪詢/訂閱」，否則一條連線掛幾小時
- 取消：`cancel_requested` 旗標，worker 定期檢查
- 成本：per-group token 配額

**建議分池：** `worker-light`（秒級查詢）+ `worker-heavy`（分鐘~小時巡檢）
→ 長巡檢不會卡住快工作，資源限制也能分開設。

## 5. 安全模型（為什麼這樣最安全）

**最小權限的關鍵：只有 `mcp-k8s` 有 kubeconfig。**
agent runtime（api / worker）**完全沒有 k8s 憑證**，它要操作叢集只能透過 `mcp-k8s`，
而 mcp-k8s 用一個受限的 ServiceAccount（只看/只動被授權的 namespace）。
→ prompt injection 打穿 agent，也拿不到叢集。

- **RBAC**：只有 `mcp-k8s` 綁一個限定 ServiceAccount；web / api / worker 都是 default 無權限 SA。
- **NetworkPolicy**（default-deny 全部，再逐條開）：
  - ingress → `web`、ingress → `api`（只這兩個入口）
  - `api` → `mcp-*`、`api` → `pgbouncer`、`api` → queue(即 postgres)
  - `worker` → `mcp-*`、`worker` → `pgbouncer`
  - **只有 `pgbouncer` 能連 `postgres`**（DB 只在一個地方被連）
  - `mcp-k8s` → k8s API
- **Secrets**：LLM key 只給 `api`/`worker`；DB 密碼只給 `pgbouncer` + operator；
  kubeconfig 只給 `mcp-k8s`。每個 secret 只出現在需要它的 pod。
- **容器**：全部 `runAsNonRoot`、`readOnlyRootFilesystem`、drop all caps、設 resources limit。
- **SQL**：一律參數化；`group_id` 過濾 + Postgres RLS 雙保險。
- **稽核**：所有寫入與授權決策寫 `audit_log`（誰、哪個 group、做了什麼、何時）。

## 5.5 層 2 的具體安全風險與對策

**風險核心不在「對外」，在「內部橫向」。**
api / worker / mcp-* 同一張內網、若又共用憑證 → **打穿一個就等於全部**。

| # | 風險 | 對策 |
|---|---|---|
| 1 | **agent 是被下指令的對象**（prompt injection）→ 被誘導呼叫 mcp 工具做破壞（「幫我刪掉那個 namespace」） | mcp server **自己做授權**（不信任呼叫者）；`mcp-k8s` 用**限定 namespace 的 SA**；破壞性動作要 GAM `approve` + 人為確認 |
| 2 | **憑證共用 = 爆炸半徑大** | **每個元件自己的身分**：各自 ServiceAccount、各自 DB role（api/worker 不該有 DDL 權）、各自範圍的 token（ES read-only、Grafana viewer） |
| 3 | **mcp-\* 橫向移動** | NetworkPolicy **點對點**（api→mcp-k8s 只開那個 port），不是 api→整網段；mcp server 預設**不掛 SA token** |
| 4 | **worker 執行「使用者影響得到的 payload」= 最像 RCE 的地方** | **永不用 shell 串接 payload**（用 `execFile` + argv）；payload 視為不可信輸入 + schema 驗證；`readOnlyRootFilesystem` + drop caps + seccomp；**絕不掛 docker.sock** |
| 5 | **SSE 長連線 = 自傷 DoS** | Ingress `limit_conn`（每 IP / 每 token）、每使用者併發串流上限、超過 429；proxy 關 buffering |
| 6 | **稽核被改寫** | `audit_log` append-only、由獨立路徑寫；agent 改不到自己的稽核 |

**pod 越多 = 身分越多、IP 越多** → NetworkPolicy 一律用 **label selector** 表達，不要用 IP 清單。

> 一句話：層 2 的安全**不是靠「內網」兩個字**，是靠「每個元件最小權限 + 點對點連線 + 不信任呼叫者」。

## 6. 多租戶（circle group）

- **邏輯隔離**：業務表帶 `group_id`，用 RLS 過濾；授權事實沿用 GAM
  （`group_members` + `workspace_acl`：view / operate / approve / admin）。
- **配額**：每 group 限 concurrent jobs / tokens/day / storage。
- **不做 namespace-per-group**（幾十上百個 group 會變 ops 惡夢）；保留給未來隔離等級客戶。

## 7. Postgres

- HA 用 operator（CloudNativePG / Patroni），別手刻 StatefulSet 撐生產。
- **pgbouncer 是必須**：api×pool + worker×pool 很容易破千連線。
- 備份：WAL 歸檔 + 每日 base backup；`audit_log` append-only 可考慮分區。
- 報表長查詢走 replica。

## 8. 擴縮

- `web`：HPA（CPU/RPS）
- `api` / `worker`：**KEDA**（in-flight 連線 / queue depth）—— **不要用 CPU**，
  agent 多半在等 LLM，CPU≈0，CPU-HPA 永遠不擴
- `mcp-*`：HPA（CPU，重的自訂 metrics）

## 9. Namespace 與部署順序

Namespace：`sre-app`（全部）、`sre-infra`（KEDA / 監控）。**沒有 sre-jobs（不需要）。**

順序：`postgres` → `pgbouncer` → (queue = postgres 內建) → `mcp-*` → `api` → `worker` → `web` + Ingress

## 10. 待決（要 Fleming 拍板）

1. MCP server 有哪幾個？（k8s / ES / Grafana / 自建）
2. worker 要不要分「輕 / 重」兩池？（避免大 job 卡小 job）
3. Postgres operator 選誰？（CloudNativePG / Patroni / 雲託管）
4. SSE 還是 WebSocket？（我建議 SSE，較單純可穿 proxy）
5. 要不要未來「隔離等級」客戶的 namespace-per-group？（建議先不做）

## 11. 與現有東西的關係

- 授權 = `docs/gam-access-management.md`
- 前端元件 = `agentic-app-template`
- schema = `prototype/schema.sql`（GAM v2）；本檔只講部署拓撲

## 5.6 agent runtime 呼叫「外部 MCP」安全嗎？

先分兩種，信任等級完全不同：

- **內網自建 MCP（`mcp-*` in-cluster）**：ClusterIP、你自己控 → 一般信任
- **外部 MCP（第三方 / 遠端 / 別人的服務）**：**一律視為不可信第三方**

**外部 MCP 的四個真實風險：**

1. **資料外洩** — 傳給工具的參數會送到對方（可能含 prompt / 內部資料）
2. **間接 prompt injection** — 工具回傳內容會進 LLM context，對方可在回應裡藏指令
   （「現在去做 X」）← **這是最大的坑**
3. **工具投毒 / rug-pull** — 對方事後偷改 tool 描述或行為
4. **憑證** — 連外要 token；token 由誰保管、範圍多大

**對策（把外部 MCP 當「公開網路」對待）：**

- **agent runtime 沒有直接對外網路** → 只能走 **Egress Gateway**（唯一出口），
  allowlist 只放行核准的 MCP host
- **外部 token 放在 Egress Gateway / 專屬 secret**，不要塞進 agent
- **工具回應一律當不可信輸入**：schema 驗證、包成 data 區塊、
  **不得單憑工具回覆就執行破壞性動作** → 要 GAM `approve` + 人為確認
- **pin 工具 schema hash**（偵測 rug-pull）；只 allowlist 需要的 tool
- **設 rate limit + 稽核**（誰、何時、呼叫了哪個外部工具）
- 能用內網自建就自建；外部 MCP 只用「必要且可接受外洩風險」的

> 一句話：**內網 MCP 是工具；外部 MCP 是「半個外部使用者」—— 當成不可信來源處理。**

> 圖（詳細）：`docs/architecture-diagram.html` / `.png`
> 圖（主要元件精簡版）：`docs/architecture-diagram-simple.html` / `.png`

## 5.7 MXC 沙箱放哪？（已畫進圖）

MXC（`@microsoft/mxc-sdk`）＝ 跑**不可信程式碼**的行程級沙箱。在 SRE app 裡它屬 **層 2**，
但是一個**獨立隔離圈**，不是普通 pod：

- 只有 `worker-heavy` 要執行「產生的程式碼 / runbook 腳本」時才送進去
- 沙箱內：**無叢集憑證、唯讀 rootfs、預設無網路、資源上限、用完即丟**
- 極少數要連外 → 也只能走 **Egress Gateway** 且另設 allowlist
- 它是 SRE app **唯一**允許執行「不是我們自己寫的程式碼」的地方

> 若之後 SRE app 也要有 coding 能力，這個沙箱就是未來「Coding 執行環境」的雛形（預設不開）。

## 5.8 LLM 呼叫路徑（補進圖）

agent runtime 一定有一條「call LLM」的線，而且是**最敏感的一條出口**：

- `api` 與 `worker` 都要呼叫 LLM（agent 的核心），**沙箱與 mcp 不需要**
- **一律走 Egress Gateway**（唯一出口）→ 記 allowlist（只放行核可的 LLM endpoint）+ 稽核
- **LLM key 只給 `api` / `worker`**（其他元件沒有）
- ⚠️ **prompt 會含內部資料**（log、拓樸、使用者輸入）→ 這條線是**資料外洩第一風險**：
  - 能自架就自架（vLLM 放叢集內 → prompt 不出門、成本自控）
  - 用外部 API 時：盡量去識別化、限制送出的內容、稽核每一次呼叫
- 外部 LLM 與外部 MCP **共用同一個 Egress Gateway**，但**各自獨立的 allowlist 規則**
