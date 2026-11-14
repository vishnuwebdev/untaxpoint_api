# UNTAXPOINT local API

## Run

```sh
cd api
node server.js
```

The first run creates `data/store.json` from demo seed data. Admin writes require `x-admin-key: change-me-local-demo` (local demo only). The API exposes `/health`, `/api/events`, `/api/users`, `/api/transactions`, `/api/admin/summary`, `POST /api/admin/fund`, `POST /api/admin/events`, and `POST /api/events/:id/participate`.

The local JSON repository is intended for single-process prototyping. Before multiple API processes or real money, replace it with MySQL transactions and uniqueness constraints. Amounts are integer cents. Event settlement runs on the event end time; it credits the selected winners' in-app wallets automatically, and releases the reserve if nobody won. PayPal, Firebase, and Maps are intentionally mock/config placeholders.

## MySQL (default storage)

The API now stores everything in MySQL 8 (`src/repo-mysql.js`); money moves run in database transactions with row locks. The original JSON store is still available with `STORAGE=json` (`src/repo-json.js`).

One-time setup in MySQL Workbench (connected as root):

1. File > Open SQL Script > `migrations/001_initial.sql`, then Execute (lightning bolt).
2. File > Open SQL Script > `migrations/002_local_setup.sql`, then Execute.

This creates the `untaxpoint` database, its tables, demo data, and a local login `untaxpoint_app` / `untaxpoint_local_dev`. Connection settings live in `api/.env` (git-ignored; template in `.env.example`). Then:

```sh
cd api
npm install
npm start   # logs "Storage: mysql (connected to untaxpoint)"
```

`GET /health` reports `"mode":"mysql"` when connected.

The current demo server is a single process and the admin key in `config.json` is not a production credential. Replace it with proper admin authentication and secrets management before deployment.
