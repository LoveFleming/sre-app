# SRE Agentic App — K8s 部署架構（v1 草案）

> 2026-10-14 Fleming 命題：web ui / app server(agent runtime) / mcp server / postgresql，
> 會開很多 circle group 的人來用，batch job 也會很多，三層式簡單一點，或許再加 batch job farm。

## 1. 設計原則

- **三層式先站穩**：presentation（web）／ application（api/agent runtime）／ data（postgres）。
  MCP server 算 application 層的「衛星服務」，batch farm 算 application 層的「非同步延伸」。
- **請求路徑要短**：使用者打字 → 幾秒內要有回應（SSE 串流）。任何長工作（掃描、報表、批次）
  **不進請求路徑**，一律丟 queue。
- **無狀態化**：api pod 不存 session / 不存檔案，全部外部化到 Postgres / 物件儲存。
- **多租戶用邏輯隔離**（group scoping + RLS），不是 namespace-per-group。

## 2. 元件與角色

| 元件 | 角色 | 型態 | 對外 |
|---|---|---|---|
| `web` | React SPA（Vite build）由 nginx 提供 | Deployment + Service | Ingress |
| `api` | agent runtime：LLM 呼叫、tool loop、授權、串流 | Deployment (HPA) | Ingress `/api` |
| `mcp-*` | 每個 MCP server 一組工具（k8s / ES / grafana / 自建） | Deployment per server | ClusterIP only |
| `worker` | **batch job farm**：吃 queue 跑長工作 | Deployment (KEDA/HPA) | 無 |
| `queue` | Redis Streams 或 Postgres SKIP LOCKED | Deployment / 搭 PG | ClusterIP |
| `postgres` | 主資料庫（GAM、workspaces、runs、audit） | StatefulSet + PVC（或 operator） | ClusterIP |
| `pgbouncer` | 連線池（很多 group + 很多 worker → 連線會炸） | Deployment | ClusterIP |

**方向性規則：**

- 瀏覽器只跟 `web` / `api` 講話，**永遠碰不到** `mcp-*` / `worker` / `postgres`。
- `api` → `mcp-*`（內網 HTTP，MCP Streamable HTTP / JSON-RPC）；`api` 不直接打外部系統。
- `worker` 只吃 queue；需要工具時一樣走 `mcp-*`。
- 所有寫入都進 `postgres`，`audit_log` 一律由 api/worker 寫（誰、哪個 group、做了什麼）。

## 3. 三層式拓撲

```
                 Internet
                    │
              ┌─────┴─────┐
              │  Ingress  │  (nginx / TLS)
              └─────┬─────┘
        ┌───────────┴────────────┐
        │                        │
   ┌────┴────┐             ┌─────┴──────┐
   │  web    │             │   api      │   ← application tier
   │ (nginx) │             │ (runtime)  │      (SSE 串流、tool loop)
   └─────────┘             └──┬───┬──┬──┘
                              │   │  │
              ┌───────────────┘   │  └────────────┐
              │                   │               │
        ┌─────┴─────┐      ┌──────┴─────┐   ┌─────┴─────┐
        │  mcp-*    │      │   queue    │   │ pgbouncer │
        └───────────┘      └──────┬─────┘   └─────┬─────┘
                                  │               │
                           ┌──────┴─────┐   ┌─────┴──────┐
                           │  worker    │──▶│  postgres  │  ← data tier
                           │ (farm)     │   │ (primary)  │
                           └────────────┘   └────────────┘
```

- **web** 可放 CDN / 多 replica，純靜態。
- **api** 無狀態橫向擴；SSE 每個 request 由單一 pod 服務全程，**不需要 sticky session**，
  但 session 歷史必須放 DB（不能放記憶體）。
- **mcp-\*** 每個 server 獨立部署 → 工具爆炸半徑隔離 + 獨立擴縮（重的 MCP 自己加資源）。

## 4. Batch Job Farm（重點）

**不要「一個任務開一個 k8s Job」** —— 任務多時會打爆 API server、調度慢、追蹤困難。
改成 **queue + 固定 worker pool**，這才是 farm：

- 佇列：Postgres `jobs` 表 + `SELECT ... FOR UPDATE SKIP LOCKED`（零新元件版本），
  或 Redis Streams（要高吞吐再換）。**先 PG，之後有瓶頸再搬 Redis。**
- `worker` Deployment：N 個 replica 常駐，拉 job → 執行 agent run → 寫回結果 + audit。
- **公平性**：每個 circle group 設 `max_concurrent`，worker 取 job 時依 group 配額挑，
  避免一個大 group 餓死其他 group。
- **擴縮**：用 **KEDA** scale（queue 長度），**不要用 CPU** —— agent 大部分時間在等 LLM，
  CPU 幾乎是 0，CPU-based HPA 永遠不會擴。
- **排程型**：CronJob 只負責「把 job 塞進 queue」（cron → enqueue），執行仍由 worker 做。
- **一次性/短命任務**（例：跑一個 k8s 診斷）才用真 k8s Job，並集中在 `sre-jobs` namespace，
  設 `activeDeadlineSeconds` + `ttlSecondsAfterFinished`，避免 Job 垃圾堆積。

**job 生命週期**：`queued → leased(worker) → running → succeeded/failed`，
lease 有 TTL（worker 掛掉 → 自動回 queue），失敗重試上限，全程寫 `audit_log`。

## 5. 多租戶（circle group）與 GAM 整合

- **邏輯隔離，不是 namespace-per-group**：幾十上百個 group 用 namespace 會變 ops 惡夢。
- 每張業務表帶 `group_id`（或 `owner_group_id`），Postgres **RLS** 用「登入者所屬 group」過濾；
  授權事實沿用 GAM：`group_members` + `workspace_acl`（view/operate/approve/admin）。
- **配額**：每 group 限制 concurrent jobs / tokens/day / storage，超額排隊或拒絕。
- namespace-per-group **保留給未來「隔離等級」客戶**（要獨立 node pool 的那種），別現在做。

## 6. Postgres

- 先 CloudNativePG / Patroni 這類 operator 做 HA（primary + replica），別手刻 StatefulSet 撐生產。
- **連線數**：api replicas × pool + worker replicas × pool，很容易破千 →
  **一定要 pgbouncer（transaction pooling）** 夾在中間。
- 備份：WAL 歸檔 + 每日 base backup 到物件儲存；`audit_log` 是 append-only，考慮分區表。
- 長查詢（報表）走 replica，別打 primary。

## 7. 擴縮策略速記

- `web`：HPA（CPU/RPS 都行）
- `api`：**KEDA**（同時連線數 / in-flight requests），SSE 是長連線 → HPA 看 CPU 會誤判
- `worker`：**KEDA**（queue depth / lag）
- `mcp-*`：HPA（CPU，重的自訂 metrics）

## 8. Namespace / 資源規劃（初版）

- `sre-app`：`web` `api` `mcp-*` `worker` `pgbouncer` `postgres`
- `sre-jobs`：一次性 k8s Job（限額 + TTL）
- `sre-infra`（可選）：KEDA、pgbouncer、監控（Prometheus / Grafana）
- 網路策略（NetworkPolicy）：`web`→`api`；`api`→`mcp-*`/`queue`/`pgbouncer`；
  `worker`→`queue`/`mcp-*`/`pgbouncer`；**只有 `pgbouncer` 能連 `postgres`**。

## 9. 部署順序

1. `postgres`（+ operator）→ `pgbouncer`
2. `queue`（PG 表或 Redis）
3. `mcp-*`
4. `api`
5. `worker`
6. `web` + Ingress

## 10. 待決問題（要 Fleming 拍板）

1. **Queue 用 PG 還是 Redis？**（我建議先 PG，之後再換）
2. **MCP server 有哪幾個？**（k8s / ES / Grafana / 自建 各自獨立部署？）
3. **worker 要不要分級？**（輕/重工作池，避免大 job 卡住小 job）
4. **Postgres operator 選哪個？**（CloudNativePG vs Patroni vs 雲託管）
5. **是否要 namespace-per-group 的隔離等級客戶？**（先不做）
6. **SSE 還是 WebSocket？**（我建議 SSE，較單純、可穿 proxy）

## 11. 與現有東西的關係

- 授權模型 = `docs/gam-access-management.md`（group + workspace_acl + TTL）
- 前端元件來源 = `agentic-app-template`（chat / side chat / tab sheet）
- 本檔只講**部署拓撲**，不講 schema；schema 見 `prototype/schema.sql`（GAM v2）
