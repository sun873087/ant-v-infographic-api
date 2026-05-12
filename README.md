# Infographic API

> Kroki-style HTTP service for **AntV Infographic**, packaged for Orion.
> 把 AntV Infographic syntax 轉成 **SVG / PNG** 的後端服務 — 給 Orion 內部使用。
> **內網部署版**:支援 Nexus npm registry + 自架 Iconify Server + outbound fetch firewall。

## ✨ 為什麼造這個

AntV Infographic 沒有官方 HTTP API。對於後端產 SVG、塞進 Markdown / Email / PDF 等場景,需要一個自架服務。

這個專案做的事:
- 把 `@antv/infographic/ssr` 包成輕量 HTTP 服務
- 支援 **SVG / PNG** 兩種輸出(PNG 走遠端 Chromium / browserless,文字 fidelity 完整)
- Redis 快取(`syntax → SVG` 是冪等)
- **OpenAPI / Swagger UI** at `/docs`
- OpenTelemetry 埋點(對齊 Orion 標準)
- K8s 友好(probes、HPA、NetworkPolicy)
- **內網設計 + 資安防護**:走 Nexus + 自架 Iconify + outbound fetch allow-list,不洩漏資料到公網

## 🏗️ 架構

```
┌──────────────┐
│ Orion Backend│
└──────┬───────┘
       │ HTTP
       ▼
┌──────────────────────────────────────────────────┐
│ Fastify (TypeScript) — ~400MB image              │
│  ├─ Routes (validation, error map, /docs)        │
│  ├─ Renderer                                     │
│  │    ├─ SVG: @antv/infographic/ssr              │
│  │    ├─ PNG: playwright → remote Chromium ──────┐
│  │    └─ registerResourceLoader ──────────┐      │
│  └─ Cache (Redis, SHA256 key)            │      │
└──────┬──────────────┬────────────────────┘      │
       │              │                            │  WS (CDP/Playwright)
       ▼              ▼                            ▼
   ┌────────┐    ┌──────────┐         ┌──────────────────┐
   │ Redis  │    │   OTel   │         │ browserless      │
   └────────┘    └──────────┘         │ (Chromium pool)  │
                                       └──────────────────┘
                                       ┌──────────────────┐
                                       │ 內網 Iconify     │
                                       └──────────────────┘
```

**Resource loader 路由**:
- syntax 中的 `icon mdi/foo` → `${ICONIFY_API_HOST}/mdi/foo.svg`
- syntax 中的 illustration → `${ILLUSTRATION_HOST}/...`(可選,空字串停用)
- 取不到時自動回 placeholder `?` symbol,**不會** fallback 到 upstream 的公網 search service

**雙層資安防護**:
1. Custom resource loader 攔截 `source=custom` 的 icon/illus 請求,失敗時也回 placeholder
2. `fetch-firewall.ts` monkey-patch `globalThis.fetch`,只允許 `ALLOWED_FETCH_HOSTS` 列出的 hostname。即便 syntax 用 `ref:remote:` / `ref:search:` 想繞過,也會被擋

## 🚀 本機開發

> 推薦先看 `make help` — 整個 lifecycle(deps、build、Docker、smoke、demos)都有 target。
> 下面是手動指令版,供想理解每一步的人參考。

```bash
# 1. 本機跑一個 Iconify server(離線就有所有圖示)
docker run -d --name iconify -p 3001:3000 iconify/api:latest

# 2. 跑一個 Redis
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 3. 跑一個 browserless(PNG 渲染用 Chromium pool)
docker run -d --name browserless -p 3002:3000 \
  -e TOKEN=local-test-token \
  ghcr.io/browserless/chromium:latest

# 4. 起服務
cp .env.example .env
# 編輯 .env,確認 ICONIFY_API_HOST、BROWSER_WS_ENDPOINT 都對
npm install
npm run dev

# 想用 container 跑(production-like):
make docker-up      # build + 起 deps + 起 API container,全部一鍵
make smoke          # 健康檢查 + 一筆 render
make demos          # 渲染 6 個複雜 demo 到 test/clients/output/complex/
make docker-down    # 停掉 API container
make deps-down      # 停掉 Redis + Iconify
```

```bash
# POST → SVG (預設)
curl -X POST http://localhost:3000/render \
  -H 'Content-Type: application/json' \
  -d '{
    "syntax": "infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label Step 1\n      desc Start\n    - label Step 2\n      desc Done"
  }' \
  -o output.svg

# POST → PNG
curl -X POST 'http://localhost:3000/render?format=png' \
  -H 'Content-Type: application/json' \
  -d '{"syntax":"infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label A"}' \
  -o output.png

# GET API (Kroki-style, 適合塞進 Markdown <img>)
SYNTAX="infographic list-row-simple-horizontal-arrow
data
  items
    - label A
    - label B"
ENCODED=$(echo -n "$SYNTAX" | base64 | tr '+/' '-_' | tr -d '=')
curl "http://localhost:3000/render/${ENCODED}.svg" -o output.svg
curl "http://localhost:3000/render/${ENCODED}.png" -o output.png

# 互動式 API 文件(macOS: open / Linux: xdg-open / Windows: start)
open http://localhost:3000/docs
```

> **Windows 開發者**:請看下面 [🪟 Windows 注意事項](#-windows-注意事項)。

## 📡 API 規格

| Method | Path | 用途 |
|--------|------|------|
| `POST` | `/render?format=svg\|png` | 主力 API,body `{ "syntax": "..." }`,預設 `svg` |
| `GET`  | `/render/:encoded.svg` | Kroki 風格,syntax 用 base64url 編碼塞 URL |
| `GET`  | `/render/:encoded.png` | 同上,PNG |
| `GET`  | `/healthz` | Liveness probe |
| `GET`  | `/readyz` | Readiness probe(會跑一次真實渲染驗證) |
| `GET`  | `/templates` | 模板清單(目前 stub) |
| `GET`  | `/docs` | **Swagger UI**(互動式 API 文件) |
| `GET`  | `/docs/json` | OpenAPI 3.0 spec(餵給 Postman / 產 SDK) |

### Response headers
- `X-Cache: HIT | MISS` — Redis 快取狀態(只記錄 SVG;PNG 由 SVG 即時轉)
- `Content-Type: image/svg+xml; charset=utf-8` 或 `image/png`

### Error codes
| HTTP | 含義 |
|------|------|
| `400` | Syntax 解析失敗 / 請求格式錯 |
| `413` | Syntax 超過 `MAX_SYNTAX_BYTES` |
| `500` | 內部錯誤 |
| `504` | 渲染逾時 |

## ⚙️ 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `HOST` | `0.0.0.0` | 監聽位址 |
| `PORT` | `3000` | 監聽 port |
| `LOG_LEVEL` | `info` | pino log level |
| `REDIS_URL` | `redis://localhost:6379` | Redis 連線字串 |
| `CACHE_TTL_SECONDS` | `86400` | SVG 快取存活時間 |
| `CACHE_ENABLED` | `true` | 是否啟用快取 |
| `RENDER_TIMEOUT_MS` | `10000` | 單次渲染逾時 |
| `MAX_SYNTAX_BYTES` | `65536` | Syntax byte 上限 |
| **`ICONIFY_API_HOST`** | `https://iconify.your-company.internal` | **內網 Iconify Server URL** |
| **`ILLUSTRATION_HOST`** | `` | 內網 undraw mirror(可選) |
| `RESOURCE_FETCH_TIMEOUT_MS` | `3000` | 抓 icon 的逾時 |
| **`BROWSER_WS_ENDPOINT`** | `` | **遠端 Chromium WebSocket endpoint(browserless / 任何 playwright-server 相容)**。留空 → fallback 用本機 `chromium.launch()`(需 chromium 裝在 host,本機開發少用)。格式:`ws://browserless:3000/chromium/playwright?token=XXX`。 |
| **`ALLOWED_FETCH_HOSTS`** | `` | **Outbound fetch 白名單(comma-separated)。留空 = 不過濾(僅 dev)**。正式環境必設,只填內網需要的 host。 |
| `OTEL_ENABLED` | `true` | 是否啟用 OTel |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTel collector |
| `OTEL_SERVICE_NAME` | `infographic-api` | OTel service name |

## 🏢 內網部署準備

### 1. Nexus npm registry

`.npmrc` 已預設指向 Nexus,把 hostname 換成你們實際的:

```ini
registry=https://nexus.your-company.internal/repository/npm-public/
```

若 Nexus 是 internal CA 簽的憑證,把 Root CA 放進 `./certs/*.crt`,
Dockerfile 會自動裝進 Node 的 trust store。

### 2. 自架 Iconify Server

兩種選擇:

**A. 直接用 K8s manifest 部署(內含在這個專案)**
```bash
kubectl apply -f k8s/iconify-server.yaml
```

**B. Docker 跑(本機 / 測試)**
```bash
docker run -d -p 3001:3000 iconify/api:latest
```

📌 Iconify 官方 image `iconify/api` 把 ~200,000 個圖示打包進 image,完全離線運作。
詳見 [Iconify hosting docs](https://docs.iconify.design/api/hosting-api.html)。

### 3. 構建 image 並推到內網 registry

```bash
# 把 Root CA 放進 ./certs/(如果需要)
cp /path/to/your-ca.crt ./certs/internal-ca.crt

# 構建
docker build -t registry.internal/orion/infographic-api:0.1.0 .

# 推送
docker push registry.internal/orion/infographic-api:0.1.0
```

### 4. 部署到 K8s

```bash
kubectl create namespace orion  # 如果還沒有

# 建立 Secret(用真實 Redis URL)
cp k8s/secret.example.yaml /tmp/secret.yaml
# 編輯 /tmp/secret.yaml
kubectl apply -f /tmp/secret.yaml

# 一次部完 Iconify Server + API
kubectl apply -k k8s/
```

### 5. 驗證

```bash
kubectl -n orion port-forward svc/infographic-api 3000:80
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz   # 會跑一次真實渲染
```

## 🐳 Docker(離線環境)

如果連 Nexus 都打不到、需要離線 build:

```bash
# 在能上網的機器上構建並 save
docker build -t orion/infographic-api:0.1.0 .
docker save orion/infographic-api:0.1.0 | gzip > infographic-api.tar.gz

# 搬到內網
scp infographic-api.tar.gz internal-jumpbox:/tmp/

# 在內網
docker load < /tmp/infographic-api.tar.gz
docker tag orion/infographic-api:0.1.0 registry.internal/orion/infographic-api:0.1.0
docker push registry.internal/orion/infographic-api:0.1.0
```

## 🪟 Windows 注意事項

專案完全跨平台,但有幾個情境需要小調整:

| 情境 | macOS / Linux | Windows |
|------|---------------|---------|
| 開瀏覽器 | `open <url>` | `start <url>`(PowerShell / cmd) |
| 複製 `.env` | `cp .env.example .env` | `copy .env.example .env`(cmd)/ `Copy-Item` (PS)/ `cp` (Git Bash) |
| `curl` + `base64 \| tr ...` one-liner | 直接跑 | 用 **Git Bash**;PowerShell 沒這些 Unix 工具 |
| Python 指令 | `python3` | `python`(官方安裝程式預設名)— vitest test 已自動偵測 |
| Docker / Docker Desktop | 都一樣 | 都一樣 |
| Node `--env-file=.env` | 都支援 | 都支援(需 Node ≥ 20.6) |

**建議組合**(最少摩擦):
- 裝 **Node 20.6+**(`engines` 已要求)
- 裝 **Git for Windows**(含 Git Bash + curl + base64;`bash` / Unix 工具齊全)
- 裝 **Docker Desktop**(跑 Redis / Iconify container)
- 裝 **Python 3**(client.py 測試,選用)

`npm install / build / dev / start / test` 在 PowerShell 跟 cmd 都能跑。

**Test 已處理的平台差異**:
- `bash` 不存在 → curl 那個 test 自動 skip(顯示 `[skip] bash/curl/jq missing`)
- `python3` 沒裝但有 `python` → 自動 fallback
- `npx tsx` 等命令用 `shell: true` 解 Windows 的 `npx.cmd` 找不到問題
- Client 預設輸出位置走 `os.tmpdir()` / `tempfile.gettempdir()`,不再硬編 `/tmp`

## 🤔 已知限制 / Trade-offs

1. **AntV Infographic 0.x 版**:API 還會變,目前 pin 在 `^0.2.0`。升級前先 smoke test。
2. **`registerResourceLoader` 必須走主套件**:`@antv/infographic/ssr` 只 export `renderToString`,**沒有** `registerResourceLoader`。renderer 從 `@antv/infographic` 主套件 import 並在 warmUp 時呼叫,實測 0.2.19 可用 ✓。
3. **公網 leak 風險(已防護)**:upstream 0.2.x 內建一個 icon search service(`https://www.weavefox.cn/api/v1/infographic/icon`,**hard-coded**),會在 `source=remote` / `source=search` 或我們 loader 回 null 時觸發。本服務用兩層防護:custom loader 失敗回 placeholder、`fetch-firewall` allow-list 攔截。正式部署**必須**設 `ALLOWED_FETCH_HOSTS`。
4. **PNG 渲染走遠端 Chromium (browserless)**:AntV Infographic 用 `<foreignObject>` 包 HTML/CSS 排版文字,純 SVG renderer(如 resvg)會跳過 → 文字消失。本服務改用 playwright client + 遠端 chromium(browserless)後文字 / Web Font 都正確 ✓。API image 本身不含 chromium,~400MB。**Browserless idle session 約 30s 會自動斷**,renderer 用 `getBrowser()` 在需要時 reconnect(`isConnected()` 檢查 + `'disconnected'` event),第一個 request 之後若連線斷會多 ~400ms 重連。`ALLOWED_FETCH_HOSTS` 不涵蓋遠端 chromium 內部的 fetch(那些不經過本服務 Node fetch),要在遠端 chromium 透過 `page.route` 攔截(renderer 已實作)。
5. **Playwright client/server 版本必須一致**:`package.json` 鎖在 `playwright@1.59`,因為 `ghcr.io/browserless/chromium:latest`(目前 v2.x)內含 server v1.59。升級 browserless image 時,**同步升 npm 套件**,否則 WebSocket 握手 428 Precondition Required。
6. **模板列舉**:`/templates` 目前是 stub。AntV 沒提供官方列舉 API。
7. **無認證**:假設內網信任。對外暴露前加 API Key / mTLS / Service Mesh。
8. **單 instance 渲染 = CPU bound**:HPA 用 CPU 70% 觸發,極端尖峰建議搭 Queue(RabbitMQ)。
9. **Iconify Server pull image**:K8s manifest 寫 `iconify/api:latest`,正式環境**請 pin 版本** + 推到內部 Harbor / Nexus。

## 🧪 測試

```bash
npm run test          # Vitest
npm run test:watch    # Watch mode
npm run typecheck     # tsc --noEmit
```

## 📝 後續可做

- [x] PNG 輸出 — playwright client → browserless / remote Chromium,完整 foreignObject 與 Web Font 支援
- [x] OpenAPI / Swagger UI(at `/docs`)
- [x] Outbound fetch firewall(`ALLOWED_FETCH_HOSTS`)
- [ ] PDF 輸出(用同一個 remote Chromium 走 `page.pdf()`,easy win)
- [ ] 模板列舉 API
- [ ] MCP Server 包裝(讓 Orion Agent 直接呼叫)
- [ ] Prometheus `/metrics`
- [ ] Rate limit / quota
- [ ] undraw illustrations 內網 mirror 整合
- [ ] API 認證(API Key / mTLS)
