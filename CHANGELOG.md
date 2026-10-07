# Changelog

## Entry tags

| Tag | Meaning |
| --- | --- |
| `#add` | New functionality or capability |
| `#change` | Change to existing behavior |
| `#fix` | Bug fix |
| `#remove` | Removed functionality |
| `#security` | Security fix or hardening |
| `#docs` | Documentation update |
| `#test` | Test or verification change |

## Unreleased

- `#add` Choose the oldest available tenant and form its sync batch in one transaction.
- `#test` Verify tenant selection and progress while an older tenant event is locked.
- `#docs` Select BullMQ with PostgreSQL as the planned sync queue backend.
- `#add` Assign up to 50 pending product snapshots from one tenant to a durable sync batch in one transaction.
- `#test` Verify ordered batch size, tenant isolation, eligible events and concurrent claims over PostgreSQL.
- `#add` Persist tenant-bound sync batches and link pending outbox events to their batch.
- `#security` Reject outbox links to batches from another tenant through a composite foreign key.
- `#test` Verify batch defaults, status and attempt checks, and tenant-safe outbox links in PostgreSQL.

## 0.5.0 — 2026-10-07

Sales can now be registered atomically with stock audit and idempotent retries.

- `#test` Prove overlapping sales cannot oversell stock and simultaneous retries with one key create only one sale, movement and outbox event.
- `#add` Register multi-item sales with captured prices, stock movements and pending outbox snapshots in one transaction.
- `#security` Scope sales to the authenticated tenant and actor; reject missing, foreign and archived products without exposing another tenant.
- `#fix` Replay the same sale key without another debit and reject a reused key with different intent as 409.
- `#test` Verify sale commit, rollback, replay, key conflict, tenant isolation, browser protection and invalid input over HTTP and PostgreSQL.
- `#add` Validate and normalize sale intents, then hash the canonical items and authenticated actor for future idempotent retries.
- `#test` Cover equivalent item order, repeated products, actor changes and invalid sale input before the sales endpoint is connected.
- `#add` Prepare tenant-bound sales and sale items with a unique idempotency key per tenant and captured unit prices.
- `#security` Require matching tenant links for the sale actor, items and stock movements; allow one sale movement per item.
- `#test` Verify sales schema uniqueness, value checks and cross-tenant rejection in PostgreSQL.
- `#test` Explicitly verify that PostgreSQL rejects negative product stock on update and negative movement balances.

## 0.4.0 — 2026-10-07

Product catalog and stock audit API are available.

- `#add` Read a tenant product's paginated stock movement history, including archived products.
- `#security` Scope movement history and its count to the session tenant; reject tenant-selecting query parameters.
- `#test` Verify movement pagination, ordering, archived history, permissions and isolation over HTTP and PostgreSQL.
- `#add` Archive tenant products through an admin-only, version-checked `DELETE /products/:id`.
- `#change` Preserve internal stock and movement history while publishing a new pending outbox snapshot with stock zero; repeated archives return 204 without another event.
- `#test` Verify archive isolation, version conflicts, idempotence, concurrent requests, authorization, and input validation over HTTP and PostgreSQL.
- `#add` Edit active tenant products through an admin-only `PATCH /products/:id` with an expected version and transactional stock audit.
- `#change` Store the supplied reason for manual stock adjustments and publish new outbox snapshots only when price or stock changes.
- `#test` Verify stale and concurrent updates, no-op and name-only edits, tenant isolation, permissions, and input validation over HTTP and PostgreSQL.
- `#add` Create tenant products through an admin-only `POST /products` with an initial stock movement and pending outbox snapshot in one transaction.
- `#security` Validate creation input and bind the new product to the authenticated tenant and actor; reject duplicate tenant SKUs.
- `#test` Verify product creation, zero stock, duplicate SKUs, permissions and validation over HTTP and PostgreSQL.
- `#add` Persist tenant-bound stock movements and versioned outbox snapshots for future product writes.
- `#change` Add repeatable opening-balance movements and pending sync snapshots for existing demo products.
- `#test` Verify movement/outbox constraints and seed backfill over PostgreSQL.
- `#add` Seed six demo products across the alpha and beta tenants, including shared SKUs and zero-stock examples.
- `#test` Verify product seed idempotence and preservation of edited or archived products.
- `#add` List active tenant products in fixed pages of 10 with name and zero-stock filters.
- `#security` Apply the session tenant to both product rows and pagination totals; reject tenant-selecting query parameters.
- `#test` Cover pagination, isolation, archived rows, filters and invalid input over HTTP and PostgreSQL.
- `#add` Read active product details through authenticated `GET /products/:id`, with decimal price and string version.
- `#security` Scope product lookup to the session tenant and return 404 for foreign or archived products.
- `#test` Verify product access, tenant isolation and session rejection over HTTP and PostgreSQL.
- `#add` Create the tenant-bound products table with SKU, stock, price, version and archive constraints.
- `#test` Verify product schema rules against PostgreSQL and serialize test files that share the migration database.

## 0.3.0 — 2026-10-07

Identity and browser authentication are available.

- `#add` Provide `POST /auth/logout` to expire the browser session cookie with a 204 response.
- `#security` Apply browser write protection to logout and avoid claiming to revoke already issued JWTs.
- `#test` Cover logout, missing or invalid cookies, CSRF rejection and production cookie attributes.
- `#add` Restore the current user identity through `GET /auth/me` using the HttpOnly session cookie.
- `#security` Reject missing, invalid, expired, duplicate, inactive and unknown-user sessions; read current tenant and role from PostgreSQL.
- `#test` Verify session restoration and rejection over HTTP with PostgreSQL.
- `#add` Provide `POST /auth/login` with a one-hour HttpOnly cookie and current user identity.
- `#security` Limit login requests by literal email and IP before password verification using `@nestjs/throttler`; return 429 with Retry-After and a fixed 30-second email pause.
- `#security` Run Argon2id verification for unknown and inactive accounts to reduce timing differences.
- `#test` Exercise login, cookie attributes, CSRF, rate limits and proxy-header spoofing over HTTP and PostgreSQL.
- `#add` Verify persisted user credentials with TypeORM and Argon2id, rejecting inactive accounts.
- `#security` Apply a global guard to browser writes that requires the configured origin, a custom request header and JSON bodies.
- `#test` Simulate cross-origin and form-based CSRF attempts and verify rejected requests never reach the write handler.
- `#add` Issue and verify one-hour JWT identity tokens with the configured secret, issuer, audience and restricted claims.
- `#security` Reject invalid, expired, tampered or wrongly scoped tokens and fail startup on a missing or short JWT secret.
- `#test` Cover JWT failure cases and Nest module configuration.
- `#add` Create tenant and user tables with a mandatory tenant link, role constraints and globally unique email.
- `#add` Apply migrations and seed two demo tenants with admin and operator users during setup.
- `#change` Use the TypeORM timestamp naming convention for the identity migration and one ordered, transactional runner for registered seeders.
- `#security` Store demo passwords as verifiable Argon2id hashes.
- `#test` Verify schema constraints and repeatable seed behavior against PostgreSQL.

## 0.2.0 — 2026-10-06

Database implementation completed.

- `#add` Connect the NestJS API to PostgreSQL through TypeORM with explicit migration configuration.
- `#add` Keep development and test databases in separate Compose services; publish only the development database on a configurable localhost port.
- `#test` Verify a real test database query, connection shutdown, and rejection of unsafe test targets.
- `#change` Read database settings from `apps/api/.env`; configure the development PostgreSQL port for the API and local clients through `DB_PORT`.

## 0.1.0 — 2026-10-05

Infrastructure setup.

- `#add` Set up a NestJS and TypeScript API in `apps/api`.
- `#add` Validate `NODE_ENV`, `PORT`, and `LISTEN_HOST` at startup without exposing invalid values.
- `#add` Provide a Dockerfile and Compose setup for running the API and its checks.
- `#change` Make the API self-contained with its own dependencies, lockfile, tooling and Dockerfile; keep shared orchestration at the repository root.
- `#change` Share the repository through one bind mount and isolate API dependencies, build output and compiled tests in Docker volumes.
- `#change` Make setup wait for the API to answer HTTP requests on port 3000.
- `#add` Create the local API .env on setup when missing and load its variables through Compose.
- `#fix` Start Node directly after compilation so Docker can shut down the API gracefully.
- `#add` Provide optional `make setup-local` for the pinned Node/npm and local editor dependencies via nvm.
- `#add` Enable Git in the Dev Container with a Git Feature and the shared checkout metadata.
- `#test` Add configuration tests and verify type checking, linting, tests, and build in the container.
- `#fix` Isolate check and test artifacts in temporary Docker volumes so they do not rewrite the running API environment.
- `#fix` Keep build and editor dependencies available during setup when `NODE_ENV` is production.
- `#docs` Add the project overview, technology summary, and setup instructions.
- `#docs` Simplify setup and editor instructions; keep command descriptions in `make help`.
