# Shared Shopping List

A self-hosted, mobile-friendly shopping list for one household. Open the same
private URL on each device to share one list and keep it in sync.

## What it does

- Add items with optional quantities and notes.
- Organize items into groups such as stores or categories; an item can belong to
  more than one group.
- Check items off while shopping, undo a purchase, and keep purchase history
  when clearing completed items.
- Install the app on a phone's home screen. After loading the list online, the
  last saved version is available offline in read-only mode.
- Store the shared list in a SQLite database on your own server.

There is no sign-in or per-person access control. Anyone who can reach the app
can read and change the list, so keep it on a network you trust. Offline mode
does not queue changes.

## Run locally with Docker Compose

You need Git and Docker with Compose v2.

```sh
git clone https://github.com/dustin-ward/shopping-list.git
cd shopping-list
cp .env.example .env
```

Edit `.env` and set the local browser address:

```dotenv
CANONICAL_ORIGIN=http://localhost:3000
PUBLISHED_PORT=3000
```

On a Linux Docker host, create the persistent folders and let the container's
non-root user (UID/GID `10001`) write to them:

```sh
mkdir -p data backups
sudo chown -R 10001:10001 data backups
```

Docker Desktop manages file permissions differently; you usually do not need
the `chown` command there. Start the app:

```sh
docker compose up --build -d
docker compose ps
```

Open <http://localhost:3000>. To stop the container without deleting your list,
run `docker compose down`. The database stays in `data/` and backups are stored
in `backups/`.

The local Compose file publishes only on the host's loopback address. Other
devices cannot connect through the host's LAN address; see the household setup
below for private remote access.

## Run directly with Node.js

For development without Docker, install Node.js 24 and pnpm 12.9.1. From the
project directory, install pnpm and dependencies:

```sh
npm install --global pnpm@12.9.1
pnpm install --frozen-lockfile
```

Set these local values in `.env` (create it from `.env.example` if needed):

```dotenv
DATABASE_PATH=./data/shopping-list.sqlite
CANONICAL_ORIGIN=http://localhost:5173
PORT=5173
BACKUP_DIR=./backups
```

Initialize the database and start the development server:

```sh
pnpm db:migrate
pnpm dev
```

Open <http://localhost:5173>.

## Deploy for your household

Keep the app behind a private network such as Tailscale; do not expose it to the
public internet. The app has no login, and its production Compose file binds to
host loopback. The [Operations guide](docs/operations.md) walks through a
Tailscale Serve deployment, backups, restores, and upgrades.

For a home server, the release workflow builds and publishes a Docker image to
GitHub Container Registry (GHCR) when a GitHub Release is published. GHCR
packages are private by default; for a private package, authenticate on the
server with a GitHub token that has `read:packages` access.

The prebuilt-image deployment needs only `compose.prod.yaml` and an `.env` made
from `.env.prod.example`; it does not need a source checkout. Set
`CANONICAL_ORIGIN` to the exact HTTPS URL used by your household and
`SHOPPING_LIST_IMAGE` to a published tag, for example
`ghcr.io/dustin-ward/shopping-list:vX.Y.Z`. In the deployment directory, copy
the example environment file and edit those values:

```sh
cp .env.prod.example .env
# Edit CANONICAL_ORIGIN and SHOPPING_LIST_IMAGE in .env.
docker compose -f compose.prod.yaml pull
docker compose -f compose.prod.yaml up -d
```

See [Operations](docs/operations.md) for how to get the two deployment files,
configure Tailscale Serve, set directory permissions, and create off-host
backups. If you are building from a source checkout instead, use
`docker compose up --build -d`.

## Development checks

```sh
pnpm check
pnpm lint
pnpm test
pnpm test:e2e
```

Playwright installs Chromium separately when needed:
`pnpm exec playwright install chromium`.

## More information

- [Product overview and scope](docs/product.md)
- [Architecture](docs/architecture.md)
- [Deployment, backups, and recovery](docs/operations.md)
- [Future ideas](docs/future-features.md)
