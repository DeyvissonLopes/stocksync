# StockSync

## Project overview

StockSync helps businesses manage product inventory across separate tenant accounts. It is designed to record sales safely, keep an audit history of stock changes, and synchronize product availability with an external platform.

Current scope: API bootstrap, configuration, and PostgreSQL connection. Business endpoints and the web interface are planned.

## Technologies

| Area | Technologies |
| --- | --- |
| API | Node.js, NestJS, TypeScript |
| Database | PostgreSQL, TypeORM |
| Web interface (planned) | React, TypeScript, Vite |
| Development | Docker Compose, Make |
| Testing and linting | Vitest, ESLint |

## Run the API

With Docker Engine, Docker Compose v2.24+ and Make installed, run from the project root. If port 5432 is already in use, first copy `apps/api/.env.example` to `apps/api/.env` and set `DB_PORT` to a free port:

```sh
make setup
```

API: http://127.0.0.1:3000. PostgreSQL is published on `127.0.0.1:5432` by default. Local Node.js/npm are optional.
Edit `apps/api/.env` to configure both databases. `make setup` creates it from `apps/api/.env.example` when missing. `DB_PORT` sets both the PostgreSQL listening port and its published port; the API connects to `db` on that same port.

To stop:

```sh
make down
```

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
