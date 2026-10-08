# StockSync

## Project overview

StockSync helps businesses manage product inventory across separate tenant accounts. It is designed to record sales safely, keep an audit history of stock changes, and synchronize product availability with an external platform.

Current scope: API bootstrap, PostgreSQL persistence, browser write protection, token login with an HttpOnly cookie, session inspection, logout, authenticated product reading and stock history, creation, editing and archiving. `POST /sales` records tenant sales with transactional stock changes and idempotent replay. Optional dispatcher and worker processes publish and consume sync batches through BullMQ in PostgreSQL. An internal HTTP mock receives versioned batches. The worker's success, retry, send cadence, terminal failure and graceful shutdown paths are tested. `GET /sync/status` reports tenant-scoped delivery status. The React/Vite frontend supports login, session restoration, logout and a paginated product catalogue; filters, sales and sync status screens are next.

## Technologies

| Area | Technologies |
| --- | --- |
| API | Node.js, NestJS, TypeScript |
| Database | PostgreSQL, TypeORM |
| Sync queue | BullMQ with PostgreSQL backend |
| Web interface | React, TypeScript, Vite, Tailwind CSS |
| Development | Docker Compose, Make |
| Testing and linting | Vitest, ESLint |

## Run the API and web app

With Docker Engine, Docker Compose v2.24+ and Make installed, run from the project root:

```sh
make setup
```

Web: http://localhost:5173. API: http://127.0.0.1:3000. Local Node.js/npm are optional.
The Vite server forwards browser requests from `/api/*` to the matching Nest
route. The browser uses one origin, so its HttpOnly session cookie works with
the API and the configured `APP_ORIGIN=http://localhost:5173`.

After setup, run `make sync-dispatcher` and `make sync-worker` to start the
optional sync pipeline. The worker target also starts the internal HTTP mock.
`SYNC_DESTINATION_URL` defaults to `http://sync-mock:3001/batches` in the
example environment; the worker validates this URL before connecting.
The worker processor loads snapshots from the persisted batch, sends one HTTP
request per attempt, requires an exact ACK and atomically marks the batch and
events as sent. Jobs retry transient errors up to five times with exponential
backoff and jitter; permanent HTTP 4xx errors (except 408/429) and exhausted
attempts mark the batch and events failed. The reconciler mirrors retained
failed jobs after a crash.
The worker limits queue starts to one per 250 ms and also spaces HTTP starts
by at least 250 ms across tenants in the single-worker deployment. A 429
delays the retry and later batches according to `Retry-After` when supplied.
The worker runs as a separate Compose service and waits for active jobs to
finish on SIGTERM. Multiple worker processes would require a shared limiter
at the HTTP send point.
`GET /sync/status` requires the session cookie and accepts no query parameters.
It returns `{ "pending": 0, "sent": 2, "failed": 0,
"lastSuccessfulSync": "2026-10-07T12:00:00.000Z" }`; the timestamp is `null`
until a batch is confirmed. Counts refer to outbox events from the current
tenant, including events waiting in a batch or retry. `sent` means the mock
acknowledged the event; `failed` means confirmation was not obtained within
the retry budget and may still reflect an update applied before a lost response.
The response is not cached. A failed batch needs manual investigation; there
is no automatic replay of terminal failures. If a retained job reports
`completed` or `unknown` while its batch remains pending or queued,
reconciliation leaves it unresolved and does not currently log that
discrepancy; inspect the batch and job before intervening.

Run `make sync-mock` to start only the external-service simulator. It has no
host port; the worker reaches it on the Compose network. `GET /health`
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
10% simulated errors and 10% timeouts, half of which occur after applying the
batch. The default `off` mode is stable; tests inject deterministic outcomes.
The mock's version and ACK fields are additions under our control. A real
external service limited to `sku`, `stock` and `price` would need a compatible
ordering contract to guarantee that late old updates cannot overwrite newer
ones. The mock uses one process; its request counter is in memory.
`make down` stops it along with the other services.

Setup applies the application migrations and the separate BullMQ schema migration.
For an existing database, run `docker compose run --rm api npm run sync:queue:migrate`
before starting a sync worker or publisher.

To stop:

```sh
make down
```

## Database configuration

Edit `apps/api/.env` to configure the development and test databases. Setup creates it from `apps/api/.env.example` if it does not exist. PostgreSQL uses `127.0.0.1:5432` by default. If that port is occupied, set `DB_PORT` to a free port before running setup.

`APP_ORIGIN` is the exact browser origin allowed to make write requests. The example uses the planned local Vite origin; set it to the actual frontend origin when that server is introduced. Production requires an HTTPS origin. Browser writes require `X-StockSync-Request: 1` and JSON bodies when a body is sent.

`JWT_SECRET` signs identity tokens. The example value is only for local development and is rejected in production; use a random secret of at least 32 bytes for deployment. The login endpoint issues the token in an HttpOnly cookie.

## Demo tenants, users and products

Setup applies the migrations and seeds two tenants, each with an admin and an operator:

| Tenant | Admin | Operator |
| --- | --- | --- |
| `alpha` | `admin@alpha.stocksync.test` | `operator@alpha.stocksync.test` |
| `beta` | `admin@beta.stocksync.test` | `operator@beta.stocksync.test` |

All four accounts use the demo password `StockSyncDemo123!`, stored as an Argon2id hash.

Setup also seeds three products per tenant. Alpha has Blue Mug, A5 Notebook and Black Pen; beta has Tote Bag, Red Mug and Blue Pen. Each tenant has a zero-stock pen. The `DEMO-CAN` and `DEMO-PEN` SKUs exist in both tenants to demonstrate isolation. Re-running `make setup` adds missing demo products without overwriting products that were edited or archived. It records an opening-balance movement for each demo product with positive stock and one pending outbox snapshot per product, including zero-stock products.

`POST /auth/login` accepts JSON `email` and `password` with literal email matching. It requires `Origin: http://localhost:5173` and `X-StockSync-Request: 1` with the example configuration. Successful login returns the current identity and sets `stocksync_token`. The login route allows five requests per literal email and thirty requests per IP in fifteen minutes, counting successful and failed logins. Excess requests return `429` with `Retry-After`; the email pause is a fixed 30 seconds. The limiter is local to one API process. The web app uses a same-origin `/api` proxy so `SameSite=Lax` can send the cookie.

`GET /auth/me` reads `stocksync_token` from the `Cookie` request header and returns the active user's current identity. Missing or invalid sessions receive `401`; the JWT is never returned in the JSON response.

`POST /auth/logout` clears the browser cookie and returns `204`, including when the cookie is missing or invalid. It requires the configured `Origin` and `X-StockSync-Request: 1`. Logout does not revoke a previously copied JWT; that token remains usable until it expires.

`GET /products/:id` requires the session cookie and returns only an active product from the user's tenant. It returns `404` for an absent, archived, or other-tenant product. The response uses a decimal string for `price` and a string for `version` to preserve bigint precision.

`GET /products` also requires the session cookie. It accepts `page` (starting at 1, default 1), `name` (case-insensitive literal substring) and `zeroStock=true`; unknown or invalid query parameters return `400`. Pages contain up to 10 active products from the current tenant, ordered by creation date and ID descending. The response has `products` and `pagination: { page, pageSize, total, totalPages }`; an empty catalog has `totalPages: 0`.

`POST /products` requires an admin session, JSON, the configured `Origin`, and `X-StockSync-Request: 1`. Send `{ "sku": "MUG-01", "name": "Blue Mug", "price": "29.90", "stock": 4 }`. SKU uses 1–64 ASCII letters, digits, dots, underscores or hyphens and begins with a letter or digit; name is trimmed to 1–100 characters; price has exactly two decimal places; stock is a nonnegative 32-bit integer. Extra fields are rejected. A successful request returns `201` with `{ "product": { "id", "sku", "name", "price", "stock", "version" } }`; version starts at `"1"`. A positive initial stock records a movement, and every created product records a pending outbox snapshot. Duplicate SKU in the same tenant returns `409`.

`PATCH /products/:id` requires an admin session and the same browser write headers. Send `expectedVersion` as a positive decimal string plus at least one of `name`, `price`, or `stock`. For example, `{ "expectedVersion": "1", "stock": 7, "reason": "Cycle count" }`. A stock field requires a trimmed reason of 1–500 characters; reason without stock is rejected. SKU and tenant cannot be edited. The route returns `200` with the product, `404` for missing, foreign, or archived products, and `409` with `PRODUCT_VERSION_CONFLICT` for a stale version. Real changes increment the version; identical values leave it unchanged. Stock changes record before/after balances and the reason. Price or stock changes add a pending outbox snapshot; name-only changes do not.

`DELETE /products/:id?expectedVersion=1` requires an admin session and the same browser write headers. For an active product, send its current `version` as the only query parameter; `1` is just the example for a newly created product. A successful archive returns `204`, records the admin, increments the version and adds a pending outbox snapshot with stock `0`. It preserves internal stock and movements; archived products disappear from catalog GET endpoints. A stale version on an active product returns `409` with `PRODUCT_VERSION_CONFLICT`; a foreign or missing product returns `404`. Repeating the archive within the same tenant returns `204` without another version or event.

`GET /products/:id/stock-movements` requires an admin or operator session. It returns movements for a product in the session tenant, including archived products, in pages of 10 ordered by creation time and ID descending. Use `?page=2` for the next page; only a positive `page` is accepted. The response has `movements` with `id`, `userId`, `reason`, `note`, `quantityDelta`, `stockBefore`, `stockAfter`, and `createdAt`, plus `pagination: { page, pageSize, total, totalPages }`. Missing or other-tenant products return `404`.

## Run checks

```sh
make test
make check
```

For command descriptions:

```sh
make help
```

## Editor setup (optional)

### VS Code Dev Container

Install the **Dev Containers** extension and select **Dev Containers: Reopen in Container** from the Command Palette.

### Local VS Code

With Bash and [nvm](https://github.com/nvm-sh/nvm#installing-and-updating) installed, run:

```sh
make setup-local
```

## AI use

Codex assisted with the API setup. The tests and build were verified in the container.
