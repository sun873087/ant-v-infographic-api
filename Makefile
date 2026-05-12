# Infographic API — Makefile
# 用 `make help` 看所有 target。

# Defaults — 用 `make <target> VAR=value` 覆寫
IMAGE      ?= infographic-api:test
CONTAINER  ?= infographic-api
REDIS_NAME ?= infographic-redis
ICONIFY_NAME ?= infographic-iconify
BROWSERLESS_NAME ?= infographic-browserless
BROWSERLESS_TOKEN ?= local-test-token
API_URL    ?= http://localhost:3000

.DEFAULT_GOAL := help

.PHONY: help install build dev start test test-unit test-clients test-watch \
        typecheck lint clean clean-all \
        docker-build docker-up docker-down docker-restart docker-logs docker-shell \
        redis iconify browserless deps-up deps-down deps-restart \
        smoke demos demos-curl demos-py demos-ts open-docs

help: ## 列出所有可用 target
	@awk 'BEGIN {FS = ":.*?## "; printf "Available targets:\n\n"} \
	      /^[a-zA-Z][a-zA-Z0-9_-]*:.*?##/ {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2} \
	      /^# ─/ {printf "\n%s\n", $$0}' $(MAKEFILE_LIST)

# ─── Node 開發 ────────────────────────────────────────
install: ## npm install
	npm install --no-audit --no-fund

build: ## 編譯 TS -> dist/
	npm run build

dev: ## tsx watch(改檔自動重啟)
	npm run dev

start: build ## node dist/server.js (跑編譯產物)
	npm start

test: ## vitest run(全部:cache + client integration)
	npm test

test-unit: ## 只跑 unit test(cache.test.ts)
	npx vitest run test/cache.test.ts

test-clients: ## 只跑 client integration test(test/clients.test.ts)
	npx vitest run test/clients.test.ts

test-watch: ## vitest watch
	npm run test:watch

typecheck: ## tsc --noEmit
	npm run typecheck

lint: ## eslint
	npm run lint

# ─── 清理 ────────────────────────────────────────────
clean: ## rm dist/ 和 test client 產出
	rm -rf dist test/clients/output

clean-all: clean ## 同上,加 rm node_modules/
	rm -rf node_modules

# ─── Docker:API container ────────────────────────────
docker-build: ## 編 Docker image $(IMAGE)
	docker build -t $(IMAGE) .

docker-up: docker-build deps-up ## build + start API container(自動帶起 deps)
	-docker rm -f $(CONTAINER) 2>/dev/null
	docker run -d --name $(CONTAINER) \
		-p 3000:3000 \
		-e REDIS_URL=redis://host.docker.internal:6379 \
		-e ICONIFY_API_HOST=http://host.docker.internal:3001 \
		-e ALLOWED_FETCH_HOSTS=host.docker.internal \
		-e BROWSER_WS_ENDPOINT='ws://host.docker.internal:3002/chromium/playwright?token=$(BROWSERLESS_TOKEN)' \
		-e OTEL_ENABLED=false \
		$(IMAGE)
	@echo ""
	@echo "  API:  $(API_URL)"
	@echo "  Docs: $(API_URL)/docs"

docker-down: ## 停掉並刪除 API container
	-docker rm -f $(CONTAINER)

docker-restart: docker-down docker-up ## 重啟 API container

docker-logs: ## tail API container log
	docker logs -f $(CONTAINER)

docker-shell: ## 進 container shell(除錯用)
	docker exec -it $(CONTAINER) sh

# ─── Docker:dependency containers ────────────────────
redis: ## 起 Redis container
	-docker rm -f $(REDIS_NAME) 2>/dev/null
	docker run -d --name $(REDIS_NAME) -p 6379:6379 redis:7-alpine

iconify: ## 起 Iconify container
	-docker rm -f $(ICONIFY_NAME) 2>/dev/null
	docker run -d --name $(ICONIFY_NAME) -p 3001:3000 iconify/api:latest

browserless: ## 起 browserless container(PNG 用)
	-docker rm -f $(BROWSERLESS_NAME) 2>/dev/null
	docker run -d --name $(BROWSERLESS_NAME) -p 3002:3000 \
		-e TOKEN=$(BROWSERLESS_TOKEN) \
		-e CONCURRENT=4 \
		ghcr.io/browserless/chromium:latest

deps-up: redis iconify browserless ## 起 Redis + Iconify + browserless
	@echo "deps ready: redis:6379, iconify:3001, browserless:3002"

deps-down: ## 停掉並刪除所有 dependency containers
	-docker rm -f $(REDIS_NAME) $(ICONIFY_NAME) $(BROWSERLESS_NAME)

deps-restart: deps-down deps-up ## 重啟 deps

# ─── Smoke / demo ────────────────────────────────────
smoke: ## 對 $(API_URL) 打 healthz / readyz + 一個 render
	@mkdir -p test/clients/output
	@curl -s -o /dev/null -w "  /healthz : HTTP %{http_code}\n" $(API_URL)/healthz
	@curl -s -o /dev/null -w "  /readyz  : HTTP %{http_code}\n" $(API_URL)/readyz
	@curl -s -X POST $(API_URL)/render -H 'Content-Type: application/json' \
		-d '{"syntax":"infographic list-row-simple-horizontal-arrow\ndata\n  items\n    - label A\n    - label B"}' \
		-o test/clients/output/smoke.svg \
		-w "  POST /render: HTTP %{http_code}  size %{size_download}B  -> test/clients/output/smoke.svg\n"

demos: ## 三語言 client 各跑一次 6 個複雜 demo (SVG+PNG)
	@bash test/clients/demos.sh
	@python3 test/clients/demos.py
	@npx tsx test/clients/demos.ts

demos-curl: ## 只跑 curl/bash 版 demo client
	@bash test/clients/demos.sh

demos-py: ## 只跑 Python 版 demo client
	@python3 test/clients/demos.py

demos-ts: ## 只跑 TypeScript 版 demo client
	@npx tsx test/clients/demos.ts

open-docs: ## 用預設瀏覽器開 Swagger UI(mac/Linux/Windows)
	@command -v open >/dev/null && open $(API_URL)/docs && exit 0; \
	 command -v xdg-open >/dev/null && xdg-open $(API_URL)/docs && exit 0; \
	 command -v start >/dev/null && start $(API_URL)/docs && exit 0; \
	 echo "請在瀏覽器開: $(API_URL)/docs"
