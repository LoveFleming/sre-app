# 🛡️ SRE App（standalone，v0.2.0）

獨立可跑的 **React + Vite + TypeScript** SRE 工作台（繁中 UI）。
不是 PAAW 的 module（不掛進 paaw-server、不吃 `@paaw-ui`、不靠 PAAW runtime）。

> 來源：Fleming 的 `paaw-sre-prototype`（模擬資料原型）。
> 這份把它還原成 standalone app，讓 PAAW coding app 用 **Import Project / Clone** 匯入當專案開發。

## 啟動

需求：Node.js 20.19+ 或 22.12+、npm。

```bash
npm install
npm run dev      # http://localhost:5175
npm run build    # 產 dist/
npm run preview  # 預覽 production build
```

預設埠 **5175**（PAAW dev UI = 5173、learning-space = 5174，刻意錯開）。

## 目錄

| 路徑 | 說明 |
|---|---|
| `index.html` | Vite 入口 |
| `src/main.tsx` | React 掛載 |
| `src/App.tsx` | SRE 主體（6 頁：總覽 / 自動巡檢 / Grafana 監控 / 異常事件 / AI Agent 工作區 / 設定）|
| `src/style.css` | 全部樣式（獨立 app，無前綴污染問題）|

## 用 PAAW coding app 開發

1. 先 clone 這個 repo（或直接指到本機目錄）
2. PAAW → Coding IDE → **Import Project**（選本機目錄）或 **Clone**（填 git URL + 父目錄）
3. 之後就跟一般專案一樣：EM 派工 → 委員會 review → release

## 邊界（沿用原設計意圖）

- **純模擬資料**（services 寫死在 `App.tsx`）
- **助理為規則式回覆**，未接 LLM
- 「執行模擬巡檢」只是 timer，**不連線、不修改任何真實系統**
- Grafana / Prometheus / K8s / NATS / audit 皆未接

要變成真的產品：憑證放後端、加 RBAC 與 scoped access、破壞性動作要人審、留下不可變的 evidence / audit trail。
