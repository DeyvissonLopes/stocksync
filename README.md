# StockSync

## Project overview

StockSync helps businesses manage product inventory across separate tenant accounts. It is designed to record sales safely, keep an audit history of stock changes, and synchronize product availability with an external platform.

## Architecture

StockSync has a React frontend and a domain-oriented modular NestJS API.
Authentication and tenancy, products, sales, and synchronization own their
routes, application rules and infrastructure dependencies. PostgreSQL stores
business data and pending updates for the external service.

Synchronization runs in separate dispatcher and worker processes. The
dispatcher forms batches from committed outbox events and publishes jobs to a
PostgreSQL-backed queue. The worker sends those batches to the external-service
mock, so sales do not depend on external delivery.

Development followed test-driven development (TDD): each behavioral slice
started with a failing test, received the smallest implementation needed to
pass, and was then refactored and validated with the project checks.

The module boundaries provide a practical foundation for adopting more
domain-driven design (DDD) patterns if the domain grows.

## Technology trade-offs

The challenge requires a Node.js API, a TypeScript frontend using React or
Angular, a database choice and a justified asynchronous queue. These choices
address StockSync's sales, tenant isolation and synchronization requirements.

- **API — NestJS.** Modules separate authentication, products, sales and sync;
  guards and providers give authorization and dependencies consistent places.
  Express could serve the same API with less framework setup, but we would
  organize and wire those boundaries ourselves. NestJS adds conventions and
  configuration.
- **Database — PostgreSQL.** PostgreSQL and MySQL both support the transactions,
  constraints and locks needed for safe sales. This implementation uses
  `UPDATE ... RETURNING` to capture stock and version after a debit for the
  outbox snapshot, and `ON CONFLICT` to arbitrate idempotency keys within a
  tenant. MySQL could provide the same guarantees with a different transaction
  flow; our SQL is specific to PostgreSQL.
- **Queue — BullMQ with PostgreSQL backend.** BullMQ schedules retries with
  backoff and tracks jobs after their attempt limit. Using its PostgreSQL
  backend avoids another service for this deployment. BullMQ with Redis would
  add a service; a custom database worker would require us to implement job
  claims and retry scheduling. The chosen backend adds migrations, connections
  and database load. The outbox, batch recovery and HTTP send limit remain
  application responsibilities.
- **Web — React with TypeScript.** React composes login, products, sales and
  sync status with local form and request state. Vite builds the client and
  proxies `/api` during development. Angular would also satisfy the UI
  requirements. Our choice leaves navigation, polling and data fetching to
  application code.

## Additional trade-offs

- **Data access — TypeORM.** Its NestJS integration supports entities for
  simple reads and a transaction manager for related writes. The sale and sync
  paths use explicit SQL where the exact database operation matters. Prisma
  could support the same flows; maintaining both entities and SQL adds work.
- **Styling — Tailwind CSS.** Utility classes keep responsive layout and visual
  states near the small set of components. CSS Modules or plain CSS would also
  work; long class lists can make JSX harder to read.
- **Local development — Docker Compose and Make.** Compose runs PostgreSQL,
  the API, web app and optional sync processes; Make provides short commands
  for setup and checks. This makes local setup repeatable at the cost of
  container resources and another command layer.

## Prerequisites

Required:

- Docker Engine
- Docker Compose plugin v2.24 or later

GNU Make is highly recommended. It is not required to run StockSync: the
project uses Docker Compose for every service. Make groups the image build,
dependency installation, migrations, seed and service startup into stable,
short commands, so it is the recommended development workflow.

On Debian or Ubuntu, install Make with:

```sh
sudo apt update && sudo apt install -y make
```

Without Make, run the sequence below from the repository root. The first
command preserves an existing `apps/api/.env`. The example values work locally;
edit that file only when you need different settings.

```sh
[ -f apps/api/.env ] || cp apps/api/.env.example apps/api/.env
[ -e .env ] || ln -s apps/api/.env .env
docker compose --profile sync build
docker compose run --rm api npm ci --include=dev
docker compose run --no-deps --rm web npm ci --include=dev
docker compose run --rm api npm run migration:run
docker compose run --rm api npm run sync:queue:migrate
docker compose run --rm api npm run seed:run
docker compose --profile sync up --wait --wait-timeout 60 --detach
```

## Run the project

From the repository root, run:

```sh
make setup
```

This prepares the database, seeds demo data, and starts the API, web app,
dispatcher, worker and external-service mock. On later runs, start all
services with `make up`. Use `make down` to stop all project containers and
the Compose network while keeping the database volumes.

Setup applies the application migrations and the separate BullMQ schema migration.
For an existing database, run `docker compose run --rm api npm run sync:queue:migrate`
before starting a sync worker or publisher.

Web: http://127.0.0.1:5173

API: http://127.0.0.1:3000


The Vite server forwards browser requests from `/api/*` to the matching Nest
route.

## Run checks

```sh
make test
make check
```

`make test` runs the API test suite. `make check` runs API type checking,
lint, tests and build, then web tests, type checking and build. The API tests
use a separate PostgreSQL test service. Tests cover concurrent sales,
idempotency, tenant isolation, retries and the product/sale-to-mock sync path.

| Required scenario | Coverage |
| --- | --- |
| Concurrent sales cannot make stock negative | `apps/api/test/sale-create.integration.spec.ts` — `allows only one of two overlapping sales to consume the remaining stock`. |
| Tenant isolation | `apps/api/test/product-list.integration.spec.ts` — `does not leak another tenant through items, count or a forged header`. |
| Retried sale is idempotent | `apps/api/test/sale-create.integration.spec.ts` — `replays equivalent requests with the same key without another stock change`. |
| External delivery retries | `apps/api/test/sync-batch-processor.integration.spec.ts` — `retries a transient HTTP failure and confirms the next successful attempt`. |

For command descriptions:

```sh
make help
```

## Environment variables

`make setup` creates `apps/api/.env` from `apps/api/.env.example` when the
file does not exist, then links it at the repository root for Docker Compose.
The example values configure the development and test databases, browser origin,
local JWT secret, sync destination and stable mock behavior. No additional
configuration is required to run the project locally.

| Variable | Default | Purpose and when to change it |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment. Set to `production` for a deployment. |
| `PORT` | `3000` | API port. Change only if the local port is occupied. |
| `LISTEN_HOST` | `127.0.0.1` | API listen address outside Compose. Compose overrides it to `0.0.0.0` inside the API container. |
| `APP_ORIGIN` | `http://127.0.0.1:5173` | Exact browser origin allowed to make writes. Change it when the frontend origin changes; production requires HTTPS. |
| `JWT_SECRET` | Local development value | Signs session tokens. Replace it with a random secret of at least 32 bytes for a deployment. |
| `DB_HOST`, `DB_PORT` | `db`, `5432` | Development PostgreSQL service and port. Change `DB_PORT` if host port 5432 is occupied. |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME` | `stocksync`, `stocksync_local`, `stocksync` | Development database credentials and name. |
| `TEST_DB_HOST`, `TEST_DB_PORT` | `db-test`, `5432` | Isolated PostgreSQL service and port used by API tests. |
| `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_DB_NAME` | `stocksync_test`, `stocksync_test_local`, `stocksync_test` | Test database credentials and name. |
| `SYNC_DESTINATION_URL` | `http://sync-mock:3001/batches` | Batch endpoint used by the worker. Change it for another sync destination. |
| `MOCK_SYNC_FAILURE_MODE` | `off` | Mock behavior: `off` is stable; `demo` enables simulated errors and timeouts. |

## Demo tenants, users and products

Setup applies the migrations and seeds two tenants, each with an admin and an operator:

| Tenant | Admin | Operator |
| --- | --- | --- |
| `alpha` | `admin@alpha.stocksync.test` | `operator@alpha.stocksync.test` |
| `beta` | `admin@beta.stocksync.test` | `operator@beta.stocksync.test` |

All four accounts use the demo password `StockSyncDemo123!`, stored as an Argon2id hash.

Setup also seeds three products per tenant. Alpha has Blue Mug, A5 Notebook and Black Pen; beta has Tote Bag, Red Mug and Blue Pen. Each tenant has a zero-stock pen. The `DEMO-CAN` and `DEMO-PEN` SKUs exist in both tenants to demonstrate isolation. Re-running `make setup` adds missing demo products without overwriting products that were edited or archived. It records an opening-balance movement for each demo product with positive stock and one pending outbox snapshot per product, including zero-stock products.

## Authentication and tenant isolation

Protected requests verify the JWT in the HttpOnly cookie, then load the active
user's current tenant and role from PostgreSQL. The client cannot choose a
tenant. Admins manage products through the API; admins and operators can read
products and register sales.

`POST /auth/login` accepts JSON `email` and `password` with literal email matching. It requires `Origin: http://127.0.0.1:5173` and `X-StockSync-Request: 1` with the example configuration. Successful login returns the current identity and sets `stocksync_token`. The login route allows five requests per literal email and thirty requests per IP in fifteen minutes, counting successful and failed logins. Excess requests return `429` with `Retry-After`; the email pause is a fixed 30 seconds. The limiter is local to one API process. The web app uses a same-origin `/api` proxy so `SameSite=Lax` can send the cookie.

`GET /auth/me` reads `stocksync_token` from the `Cookie` request header and returns the active user's current identity. Missing or invalid sessions receive `401`; the JWT is never returned in the JSON response.

`POST /auth/logout` clears the browser cookie and returns `204`, including when the cookie is missing or invalid. It requires the configured `Origin` and `X-StockSync-Request: 1`. Logout does not revoke a previously copied JWT; that token remains usable until it expires.

## Web interface

The React app provides the four challenge flows after local setup: sign in,
product catalogue, sale recording and tenant sync status. The catalogue supports
search, stock filtering and pagination; the sale screen supports multiple
products and preserves an uncertain request for an explicit retry with its
original idempotency key. Each screen presents loading, empty or error states
as applicable, and uses labelled controls, live status messages and alerts for
basic keyboard and screen-reader support.

## Products

`GET /products/:id` requires the session cookie and returns only an active product from the user's tenant. It returns `404` for an absent, archived, or other-tenant product. The response uses a decimal string for `price` and a string for `version` to preserve bigint precision.

`GET /products` also requires the session cookie. It accepts `page` (starting at 1, default 1), `name` (case-insensitive literal substring) and `zeroStock=true`; unknown or invalid query parameters return `400`. Pages contain up to 10 active products from the current tenant, ordered by creation date and ID descending. The response has `products` and `pagination: { page, pageSize, total, totalPages }`; an empty catalog has `totalPages: 0`.

`POST /products` requires an admin session, JSON, the configured `Origin`, and `X-StockSync-Request: 1`. Send `{ "sku": "MUG-01", "name": "Blue Mug", "price": "29.90", "stock": 4 }`. SKU uses 1–64 ASCII letters, digits, dots, underscores or hyphens and begins with a letter or digit; name is trimmed to 1–100 characters; price has exactly two decimal places; stock is a nonnegative 32-bit integer. Extra fields are rejected. A successful request returns `201` with `{ "product": { "id", "sku", "name", "price", "stock", "version" } }`; version starts at `"1"`. A positive initial stock records a movement, and every created product records a pending outbox snapshot. Duplicate SKU in the same tenant returns `409`.

`PATCH /products/:id` requires an admin session and the same browser write headers. Send `expectedVersion` as a positive decimal string plus at least one of `name`, `price`, or `stock`. For example, `{ "expectedVersion": "1", "stock": 7, "reason": "Cycle count" }`. A stock field requires a trimmed reason of 1–500 characters; reason without stock is rejected. SKU and tenant cannot be edited. The route returns `200` with the product, `404` for missing, foreign, or archived products, and `409` with `PRODUCT_VERSION_CONFLICT` for a stale version. Real changes increment the version; identical values leave it unchanged. Stock changes record before/after balances and the reason. Price or stock changes add a pending outbox snapshot; name-only changes do not.

`DELETE /products/:id?expectedVersion=1` requires an admin session and the same browser write headers. For an active product, send its current `version` as the only query parameter; `1` is just the example for a newly created product. A successful archive returns `204`, records the admin, increments the version and adds a pending outbox snapshot with stock `0`. It preserves internal stock and movements; archived products disappear from catalog GET endpoints. A stale version on an active product returns `409` with `PRODUCT_VERSION_CONFLICT`; a foreign or missing product returns `404`. Repeating the archive within the same tenant returns `204` without another version or event.

`GET /products/:id/stock-movements` requires an admin or operator session. It returns movements for a product in the session tenant, including archived products, in pages of 10 ordered by creation time and ID descending. Use `?page=2` for the next page; only a positive `page` is accepted. The response has `movements` with `id`, `userId`, `reason`, `note`, `quantityDelta`, `stockBefore`, `stockAfter`, and `createdAt`, plus `pagination: { page, pageSize, total, totalPages }`. Missing or other-tenant products return `404`.

## Sales and consistency

`POST /sales` accepts one or more `{ "productId": "...", "quantity": 1 }`
items and requires an `Idempotency-Key` UUID v4, the session cookie and the
browser write headers. Each stock debit is conditional on sufficient stock
inside one PostgreSQL transaction. The transaction also records the sale,
items, stock movements and immutable outbox snapshots. If any item lacks
stock, all changes roll back; the sale request never waits for the external
service.

The idempotency key is unique within a tenant. Retrying the same request with
the same key returns the original sale without another stock debit; reusing
the key for a different sale returns `409`. The frontend retains the key and
payload when a response is uncertain and retries only after an explicit user
action.

## Synchronization

After setup, control the sync services individually:

| Command | Effect |
| --- | --- |
| `make sync-dispatcher` / `make sync-dispatcher-stop` | Start or stop batch creation and job publication. |
| `make sync-worker` / `make sync-worker-stop` | Start or stop batch delivery. Starting the worker also starts the mock. |
| `make sync-mock` / `make sync-mock-stop` | Start or stop only the external-service mock. |

Stopping the dispatcher leaves existing jobs available to the worker, but no
new batches are formed. Stopping the worker leaves updates pending for later
delivery. Stopping the mock while the worker runs makes pending deliveries
retry and can eventually mark a batch failed; restarting the mock does not
replay a terminal failure automatically.

`SYNC_DESTINATION_URL` defaults to `http://sync-mock:3001/batches` in the
example environment; the worker validates this URL before connecting.

The worker loads snapshots from the persisted batch, sends one HTTP request
per attempt, requires an exact ACK and atomically marks the batch and events
as sent. Jobs retry transient errors up to five times with exponential backoff
and jitter; permanent HTTP 4xx errors (except 408/429) and exhausted attempts
mark the batch and events failed. The reconciler mirrors retained failed jobs
after a crash. A failed batch needs manual investigation; terminal failures
are not replayed automatically.

The worker limits queue starts to one per 250 ms and also spaces HTTP starts
by at least 250 ms across tenants in the single-worker deployment. A 429
delays the retry and later batches according to `Retry-After` when supplied.
The worker runs as a separate Compose service and waits for active jobs to
finish on SIGTERM. Multiple worker processes would require a shared limiter
at the HTTP send point.

`GET /sync/status` requires the session cookie and accepts no query parameters.
It returns `pending`, `sent`, `failed` and `lastSuccessfulSync`; the timestamp
is `null` until a batch is confirmed. Counts refer to outbox events from the
current tenant, including events waiting in a batch or retry. `sent` means the
mock acknowledged the event; `failed` means confirmation was not obtained
within the retry budget and may still reflect an update applied before a lost
response.
The response is not cached. If a retained job reports `completed` or `unknown`
while its batch remains pending or queued, reconciliation leaves it unresolved
and does not currently log that discrepancy; inspect the batch and job before
intervening.

The mock has no host port; the worker reaches it on the Compose network. `GET /health`
reports process health. The mock accepts
`POST /batches` with `batchId`, `tenantId` and one to 50 updates containing
`eventId`, `productId`, `sku`, `stock`, decimal-string `price` and decimal-string
`version`. A successful response returns the batch ID and every event ID in
`acknowledgedEventIds`. It preserves only the newest version of each
tenant/product in the separate `mock_sync` schema. Repeated or older versions
are acknowledged without changing that state; conflicting values at the same
version return `409` and roll back the batch.

The mock rejects more than five calls in a moving second with `429` and
`Retry-After`. Set `MOCK_SYNC_FAILURE_MODE=demo` in `apps/api/.env` for about
20% total simulated failures: about 10% errors and 10% timeouts. Half of the
timeouts occur after applying the batch. The default `off` mode is stable;
tests inject deterministic outcomes.
The mock's version and ACK fields are additions under our control. A real
external service limited to `sku`, `stock` and `price` would need a compatible
ordering contract to guarantee that late old updates cannot overwrite newer
ones. The mock uses one process; its request counter is in memory.

## Known limitations

- The mock's version and acknowledgement contract is controlled by this project. A real external service that accepts only SKU, stock and price needs an ordering contract before we can guarantee that an old update never overwrites a newer one.
- Rate limiting for login and outbound sync sends assumes one API and one worker process. The worker's `Retry-After` cooldown is not persisted across restarts.
- A terminal `failed` status means confirmation was not obtained. An update may already have reached the destination; investigation is required, and no replay endpoint exists. Jobs and events have no automated cleanup policy.
- If a retained BullMQ job reports `completed` or `unknown` while its batch is still `pending` or `queued`, the reconciler leaves it unresolved. It does not repair the batch, republish it or emit an operational log.
- The frontend has no URL-based navigation. Switching tabs discards a sale draft that has not been submitted. An uncertain submitted sale is preserved with its original idempotency key for explicit retry.
- Compose runs the Vite development server and local demo credentials. Production serving and secrets management need separate deployment work.

## Further work

- Add an authorized, audited replay workflow and UI for failed batches.
- Add a dedicated dead-letter queue and retention policy for terminal failures.
- Support multiple API and worker replicas with shared outbound rate limiting.
- Add structured logs, metrics, alerts and dashboards for retries, failed batches and delivery latency.
- Evaluate PostgreSQL row-level security as defense in depth for tenant isolation, including connection-pool and worker context.
- Add CSRF tokens if the browser client must run from a different origin; the current same-origin deployment uses exact Origin and custom-header checks.
- Add URL-based navigation and persistent local sale drafts.
- Add production web serving, secrets management and a CI pipeline.
- Adopt DDD patterns incrementally if the domain grows, starting with explicit
  bounded contexts and domain-level contracts where they reduce coupling.

## AI use

Codex assisted with architecture comparisons, API and frontend implementation,
tests and documentation. Decisions were discussed against the challenge
requirements, and each implementation slice was reviewed before its commit.
Behavioral tests were run red before implementation, then validated with
`make check` in Docker. The sync pipeline was also exercised through separate
Compose processes, and the browser flow was checked in Chrome on desktop and
mobile. The browser smoke test selected sale items without posting a real
sale to the demo database; the sale-to-sync path is covered by the PostgreSQL
and queue integration test.

## Editor setup (optional)

### VS Code Dev Container

Install the **Dev Containers** extension and select **Dev Containers: Reopen in Container** from the Command Palette.

### Local VS Code

With Bash and [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) installed, run:

```sh
make setup-local
```
