.DEFAULT_GOAL := help
API_ARTIFACT_DIRS := apps/api/node_modules apps/api/dist apps/api/.test-build
CHECK_VOLUMES := -v /app/apps/api/node_modules -v /app/apps/api/dist -v /app/apps/api/.test-build
WEB_CHECK_VOLUMES := -v /app/apps/web/node_modules -v /app/apps/web/dist

.PHONY: help setup setup-local build up sync-dispatcher sync-dispatcher-stop sync-worker sync-worker-stop sync-mock sync-mock-stop test check down

help:
	@printf 'StockSync commands:\n'
	@printf '  make setup  Create the API .env, build, migrate, seed and start all services.\n'
	@printf '  make setup-local  Install project Node/npm and local IDE dependencies (requires nvm).\n'
	@printf '  make build  Rebuild all project images.\n'
	@printf '  make up     Start all services after setup.\n'
	@printf '  make sync-dispatcher  Start the optional sync dispatcher.\n'
	@printf '  make sync-dispatcher-stop  Stop only the sync dispatcher.\n'
	@printf '  make sync-worker  Start the optional sync worker and mock.\n'
	@printf '  make sync-worker-stop  Stop only the sync worker.\n'
	@printf '  make sync-mock  Start the internal external-service simulator.\n'
	@printf '  make sync-mock-stop  Stop only the external-service simulator.\n'
	@printf '  make test   Run the tests in a temporary container.\n'
	@printf '  make check  Check API and web in temporary containers.\n'
	@printf '  make down   Stop and remove the Compose services and network.\n'

setup: .env $(API_ARTIFACT_DIRS)
	@set -e; \
	log_file=$$(mktemp); \
	trap 'rm -f "$$log_file"' EXIT; \
	run_step() { \
		label=$$1; shift; \
		printf '%s... ' "$$label"; \
		if "$$@" >"$$log_file" 2>&1; then \
			printf 'done\n'; \
		else \
			status=$$?; \
			printf 'failed\n' >&2; \
			cat "$$log_file" >&2; \
			return "$$status"; \
		fi; \
	}; \
	run_step 'Build images' docker compose --profile sync build; \
	run_step 'Install API dependencies' docker compose run --rm api npm ci --include=dev; \
	run_step 'Install web dependencies' docker compose run --no-deps --rm web npm ci --include=dev; \
	run_step 'Run database migrations' docker compose run --rm api npm run migration:run; \
	run_step 'Run sync queue migrations' docker compose run --rm api npm run sync:queue:migrate; \
	run_step 'Seed demo data' docker compose run --rm api npm run seed:run; \
	run_step 'Start services' docker compose --profile sync up --wait --wait-timeout 60 --detach; \
	printf '\nWeb: http://127.0.0.1:5173\n'; \
	setup_node_env=$$(sed -n 's/^NODE_ENV=//p' apps/api/.env | tail -n 1); \
	if [ "$$setup_node_env" = development ] && command -v xdg-open >/dev/null 2>&1 && \
		{ [ -n "$${DISPLAY:-}" ] || [ -n "$${WAYLAND_DISPLAY:-}" ]; }; then \
		xdg-open http://127.0.0.1:5173 >/dev/null 2>&1 & \
	fi

.env: apps/api/.env
	@ln -s apps/api/.env .env

apps/api/.env:
	@cp apps/api/.env.example apps/api/.env

$(API_ARTIFACT_DIRS):
	@mkdir -p $@

setup-local: SHELL := /bin/bash
setup-local:
	@export NVM_DIR="$${NVM_DIR:-$$HOME/.nvm}"; \
	if [ ! -s "$$NVM_DIR/nvm.sh" ]; then \
		printf 'Install nvm first: https://github.com/nvm-sh/nvm#installing-and-updating\n' >&2; \
		exit 1; \
	fi; \
	cd apps/api && \
	. "$$NVM_DIR/nvm.sh" --no-use && \
	nvm install && \
	nvm use && \
	npm install --global "$$(node -p "require('./package.json').packageManager")" && \
	npm ci --include=dev && \
	npm run typecheck && \
	cd ../web && \
	nvm use && \
	npm ci --include=dev && \
	npm run typecheck

build: .env
	docker compose --profile sync build

up: .env $(API_ARTIFACT_DIRS)
	docker compose --profile sync up --build --wait --wait-timeout 60 --detach

sync-dispatcher: .env
	docker compose --profile sync up --build --detach dispatcher

sync-dispatcher-stop: .env
	docker compose --profile sync stop dispatcher

sync-worker: .env
	docker compose --profile sync up --build --detach worker

sync-worker-stop: .env
	docker compose --profile sync stop worker

sync-mock: .env
	docker compose --profile sync up --build --detach sync-mock

sync-mock-stop: .env
	docker compose --profile sync stop sync-mock

test: .env $(API_ARTIFACT_DIRS)
	@set -e; \
	trap 'docker compose stop db-test' EXIT; \
	docker compose up -d --wait db-test; \
	docker compose run --no-deps --build --rm -e NODE_ENV=test $(CHECK_VOLUMES) api npm test

check: .env $(API_ARTIFACT_DIRS)
	@set -e; \
	trap 'docker compose stop db-test' EXIT; \
	docker compose up -d --wait db-test; \
	docker compose run --no-deps --build --rm -e NODE_ENV=test $(CHECK_VOLUMES) api npm run check
	docker compose run --no-deps --build --rm $(WEB_CHECK_VOLUMES) web npm run check

down: .env
	docker compose --profile test --profile sync down
