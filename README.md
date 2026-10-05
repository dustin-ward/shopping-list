# Shared Shopping List

A mobile-first, collaborative shopping list for one household. The application
is self-hostable with Docker Compose and designed for tailnet-only access.

## Implementation status

The online shopping cycle, SQLite persistence and migrations, revision-guarded
collaboration, installable PWA shell, read-only offline snapshot, and operational
backup/restore tooling are implemented. Automated unit, integration, and
production-mode browser tests are available.

The GitHub Release workflow is configured to publish to GHCR but has not yet run.
This environment has no Docker engine, so the image and Compose deployment have
not been built or started here. Proxmox LXC networking and bind-mount ownership,
real iOS Safari/Android Chrome behavior, and the production Tailscale topology
still need deployment/device verification.

## Run locally

Prerequisites: Node.js 24 LTS and pnpm 12.9.1.

```sh
npm install --global pnpm@12.9.1
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env` for local development before starting:

```dotenv
DATABASE_PATH=./data/shopping-list.sqlite
CANONICAL_ORIGIN=http://localhost:5173
PORT=5173
```

Then initialize the database and start the Vite development server:

```sh
pnpm db:migrate
pnpm dev
```

Open <http://localhost:5173>. Production startup applies committed migrations
and bootstraps the shared list before listening:

```sh
pnpm build
pnpm start
```

## Checks and tests

```sh
pnpm check          # Svelte/TypeScript and service-worker type checks
pnpm lint
pnpm format:check
pnpm test           # Unit and temporary-SQLite integration tests
pnpm test:e2e       # Production build plus Playwright browser tests
pnpm db:check
```

Playwright downloads Chromium separately when needed: `pnpm exec playwright
install chromium`.

## GitHub releases

Publishing a GitHub Release runs `.github/workflows/release.yml`. It verifies the
release with the type checks, lint, unit/integration tests, and production browser
tests, then builds the Dockerfile for `linux/amd64` and publishes it to GHCR using
the built-in `GITHUB_TOKEN` (no registry secret is needed in the repository).

For a release tag such as `v1.2.3`, the workflow publishes `v1.2.3`, `1.2.3`,
`1.2`, and the commit SHA tag. Stable releases also update `latest`. Create and
publish a GitHub Release to run the workflow; merely pushing a tag does not
trigger it. GHCR packages are private by default. Make the package public in its
GitHub package settings if the LXC should pull without credentials.

To deploy a published image, set `SHOPPING_LIST_IMAGE` in `.env` to
`ghcr.io/<owner>/<repository>:latest`, then pull and recreate the service:

```sh
docker compose pull
docker compose up -d --no-build
```

For a private GHCR package, authenticate on the LXC with a GitHub token that has
`read:packages` access before pulling. Leaving `SHOPPING_LIST_IMAGE` unset keeps
the existing local `docker compose up --build` workflow.

## Deployment and backups

The Compose port is published on host loopback only for Tailscale Serve; do not
change it to `0.0.0.0`. Copy `.env.example`, set `CANONICAL_ORIGIN` to the
household's HTTPS tailnet hostname, and follow [Operations](docs/operations.md)
for the LXC setup, volume ownership, updates, backups, and restore procedure.

For a local backup, set `BACKUP_DIR=./backups` in `.env` and run `pnpm db:backup`.
The script uses SQLite's online backup API and validates the resulting database.
Keep an off-host copy; the Compose backup directory is on the same machine and
is not disaster recovery.

## Product and design documents

- [Product specification](docs/product.md)
- [Architecture](docs/architecture.md)
- [Implementation plan and acceptance tests](docs/implementation-plan.md)
- [Deferred future features](docs/future-features.md)
- [Deployment and recovery operations](docs/operations.md)

Accounts, public access, offline editing, recommendations, pricing, and receipt
handling remain out of scope. The last verified current list stays readable on
this browser until cleared or evicted; offline history and edits are not
available. Browser storage is best-effort and is not a replacement for a server
backup.
