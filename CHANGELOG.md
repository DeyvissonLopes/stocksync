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

- `#add` Connect the NestJS API to PostgreSQL through TypeORM with explicit migration configuration.
- `#add` Keep development and test databases in separate Compose services; publish only the development database on a configurable localhost port.
- `#test` Verify a real test database query, connection shutdown, and rejection of unsafe test targets.
- `#change` Read database settings from `apps/api/.env`; configure the development PostgreSQL port for the API and local clients through `DB_PORT`.

## 0.1.0 — 2026-10-05

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
