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
