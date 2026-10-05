.DEFAULT_GOAL := help
API_ARTIFACT_DIRS := apps/api/node_modules apps/api/dist apps/api/.test-build
CHECK_VOLUMES := -v /app/apps/api/node_modules -v /app/apps/api/dist -v /app/apps/api/.test-build

.PHONY: help setup setup-local build up test check down

help:
	@printf 'StockSync commands:\n'
	@printf '  make setup  Create missing API .env, build and start; wait for HTTP readiness.\n'
	@printf '  make setup-local  Install project Node/npm and local IDE dependencies (requires nvm).\n'
	@printf '  make build  Rebuild the API image.\n'
	@printf '  make up     Start the API with Docker Compose.\n'
	@printf '  make test   Run the tests in a temporary container.\n'
	@printf '  make check  Run types, lint, tests and build in a temporary container.\n'
	@printf '  make down   Stop and remove the Compose services and network.\n'

setup: apps/api/.env $(API_ARTIFACT_DIRS)
	docker compose build api
	docker compose run --rm api npm ci --include=dev
	docker compose up --wait --wait-timeout 60 --detach

apps/api/.env:
	cp apps/api/.env.example apps/api/.env

$(API_ARTIFACT_DIRS):
	mkdir -p $@

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
	npm run typecheck

build:
	docker compose build api

up: $(API_ARTIFACT_DIRS)
	docker compose up

test: $(API_ARTIFACT_DIRS)
	docker compose run --build --rm $(CHECK_VOLUMES) api npm test

check: $(API_ARTIFACT_DIRS)
	docker compose run --build --rm $(CHECK_VOLUMES) api npm run check

down:
	docker compose down
