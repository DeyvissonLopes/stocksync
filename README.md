# StockSync

## Project overview

StockSync helps businesses manage product inventory across separate tenant accounts. It is designed to record sales safely, keep an audit history of stock changes, and synchronize product availability with an external platform.

Current scope: API bootstrap, PostgreSQL persistence, browser write protection, token login with an HttpOnly cookie, session inspection, logout, and authenticated product listing and detail reading. Product writes and the web interface are planned.

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

## Demo tenants and users

Setup applies the identity migration and seeds two tenants, each with an admin and an operator:

| Tenant | Admin | Operator |
| --- | --- | --- |
| `alpha` | `admin@alpha.stocksync.test` | `operator@alpha.stocksync.test` |
| `beta` | `admin@beta.stocksync.test` | `operator@beta.stocksync.test` |

All four accounts use the demo password `StockSyncDemo123!`, stored as an Argon2id hash.

`POST /auth/login` accepts JSON `email` and `password` with literal email matching. It requires `Origin: http://localhost:5173` and `X-StockSync-Request: 1` with the example configuration. Successful login returns the current identity and sets `stocksync_token`. The login route allows five requests per literal email and thirty requests per IP in fifteen minutes, counting successful and failed logins. Excess requests return `429` with `Retry-After`; the email pause is a fixed 30 seconds. The limiter is local to one API process. A browser frontend will use a same-origin `/api` proxy so `SameSite=Lax` can send the cookie.

`GET /auth/me` reads `stocksync_token` from the `Cookie` request header and returns the active user's current identity. Missing or invalid sessions receive `401`; the JWT is never returned in the JSON response.

`POST /auth/logout` clears the browser cookie and returns `204`, including when the cookie is missing or invalid. It requires the configured `Origin` and `X-StockSync-Request: 1`. Logout does not revoke a previously copied JWT; that token remains usable until it expires.

`GET /products/:id` requires the session cookie and returns only an active product from the user's tenant. It returns `404` for an absent, archived, or other-tenant product. The response uses a decimal string for `price` and a string for `version` to preserve bigint precision.

`GET /products` also requires the session cookie. It accepts `page` (starting at 1, default 1), `name` (case-insensitive literal substring) and `zeroStock=true`; unknown or invalid query parameters return `400`. Pages contain up to 10 active products from the current tenant, ordered by creation date and ID descending. The response has `products` and `pagination: { page, pageSize, total, totalPages }`; an empty catalog has `totalPages: 0`. Setup currently seeds users but no products, so the catalog starts empty.

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
