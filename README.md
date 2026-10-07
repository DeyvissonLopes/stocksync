# StockSync

## Project overview

StockSync helps businesses manage product inventory across separate tenant accounts. It is designed to record sales safely, keep an audit history of stock changes, and synchronize product availability with an external platform.

Current scope: API bootstrap, PostgreSQL persistence, browser write protection, token login with an HttpOnly cookie, session inspection, logout, authenticated product reading, creation and editing. Product archiving, sales, external sync, and the web interface are planned.

## Technologies

| Area | Technologies |
| --- | --- |
| API | Node.js, NestJS, TypeScript |
| Database | PostgreSQL, TypeORM |
| Web interface (planned) | React, TypeScript, Vite |
| Development | Docker Compose, Make |
| Testing and linting | Vitest, ESLint |

## Run the API

With Docker Engine, Docker Compose v2.24+ and Make installed, run from the project root:

```sh
make setup
```

API: http://127.0.0.1:3000. Local Node.js/npm are optional.

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

`POST /auth/login` accepts JSON `email` and `password` with literal email matching. It requires `Origin: http://localhost:5173` and `X-StockSync-Request: 1` with the example configuration. Successful login returns the current identity and sets `stocksync_token`. The login route allows five requests per literal email and thirty requests per IP in fifteen minutes, counting successful and failed logins. Excess requests return `429` with `Retry-After`; the email pause is a fixed 30 seconds. The limiter is local to one API process. A browser frontend will use a same-origin `/api` proxy so `SameSite=Lax` can send the cookie.

`GET /auth/me` reads `stocksync_token` from the `Cookie` request header and returns the active user's current identity. Missing or invalid sessions receive `401`; the JWT is never returned in the JSON response.

`POST /auth/logout` clears the browser cookie and returns `204`, including when the cookie is missing or invalid. It requires the configured `Origin` and `X-StockSync-Request: 1`. Logout does not revoke a previously copied JWT; that token remains usable until it expires.

`GET /products/:id` requires the session cookie and returns only an active product from the user's tenant. It returns `404` for an absent, archived, or other-tenant product. The response uses a decimal string for `price` and a string for `version` to preserve bigint precision.

`GET /products` also requires the session cookie. It accepts `page` (starting at 1, default 1), `name` (case-insensitive literal substring) and `zeroStock=true`; unknown or invalid query parameters return `400`. Pages contain up to 10 active products from the current tenant, ordered by creation date and ID descending. The response has `products` and `pagination: { page, pageSize, total, totalPages }`; an empty catalog has `totalPages: 0`.

`POST /products` requires an admin session, JSON, the configured `Origin`, and `X-StockSync-Request: 1`. Send `{ "sku": "MUG-01", "name": "Blue Mug", "price": "29.90", "stock": 4 }`. SKU uses 1–64 ASCII letters, digits, dots, underscores or hyphens and begins with a letter or digit; name is trimmed to 1–100 characters; price has exactly two decimal places; stock is a nonnegative 32-bit integer. Extra fields are rejected. A successful request returns `201` with `{ "product": { "id", "sku", "name", "price", "stock", "version" } }`; version starts at `"1"`. A positive initial stock records a movement, and every created product records a pending outbox snapshot. Duplicate SKU in the same tenant returns `409`.

`PATCH /products/:id` requires an admin session and the same browser write headers. Send `expectedVersion` as a positive decimal string plus at least one of `name`, `price`, or `stock`. For example, `{ "expectedVersion": "1", "stock": 7, "reason": "Cycle count" }`. A stock field requires a trimmed reason of 1–500 characters; reason without stock is rejected. SKU and tenant cannot be edited. The route returns `200` with the product, `404` for missing, foreign, or archived products, and `409` with `PRODUCT_VERSION_CONFLICT` for a stale version. Real changes increment the version; identical values leave it unchanged. Stock changes record before/after balances and the reason. Price or stock changes add a pending outbox snapshot; name-only changes do not.

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
