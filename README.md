# UNTAXPOINT API

Node.js (Express) + MySQL 8. One API serves both the **admin panel** (`/api/v1/admin/*`) and the **mobile app** (`/api/v1/*`).

## First-time setup

```sh
cd api
cp .env.example .env        # then put your MySQL user/password in .env
npm install
npm run migrate             # creates the database and all tables
npm run create-admin        # asks for email, name and password of the first super admin
npm run seed:demo           # optional: demo members, events, payouts, donations
npm start                   # http://localhost:3000
```

`npm test` runs the end-to-end tests against a separate `<DB_NAME>_test` database (created and dropped automatically).

## How the money works

All amounts are integer **cents**. Every change goes through a double-entry ledger (`transactions` + `ledger_entries`), so balances can always be rebuilt and checked (`GET /admin/finance/reconciliation`, or "Check books" in the admin panel).

| Account | Meaning |
|---|---|
| `main` | Main fund, available for new events |
| `reserved` | Prize pools of open events |
| `donations` | Donated fund (separate; never used for events automatically) |
| `payouts_pending` | Withdrawals sent to the provider but not confirmed yet |
| `user` (per member) | Member wallets |
| `external` | Money entering/leaving the platform |

- **Add funds** → `external → main`
- **Create event** → `main → reserved` (refused if the main fund is too small)
- **Settlement** (automatic, right after the end time) → `reserved → winners' wallets`, split equally; leftover cents go to the earliest winners. No winners → `reserved → main`.
- **Withdrawal** → `wallet → payouts_pending → external`; failed or rejected → back to the wallet
- **Donation** → `wallet → donations`

## Event rules (enforced by the server)

- The server orders entries: the event row is locked, so simultaneous entries get unique sequence numbers and winner slots are never given twice.
- Entry checks: event live and inside its time window, not paused, no duplicate, no mock location, GPS accuracy within the limit, inside the radius. Rejected attempts are stored for reporting.
- Reaching the winner limit does **not** end the event; later entries are recorded as non-winners.
- Location, prize, winners and timing cannot change once the event started or has entries.
- An event with entries cannot be cancelled (pause it; it still settles at its end time). Cancelling an event without entries returns the pool.
- Unpublished drafts that pass their end time expire and return their pool.
- Settlement is idempotent: running it twice never pays twice.

## Background jobs

Run inside the API process every `JOB_INTERVAL_SECONDS` (default 60): activate events that started, settle events that ended, resend stuck withdrawals.

## Payments

`PAYMENT_PROVIDER=mock` (default) confirms funding and payouts instantly without moving real money. For testing, a PayPal email containing `fail` makes the payout fail and one containing `pending` keeps it pending. To go live, add `src/services/payments/paypal.js` with the same two functions and set `PAYMENT_PROVIDER=paypal`.

## Admin roles

| Role | Can |
|---|---|
| `super_admin` | Everything, including settings and admin accounts |
| `finance_admin` | Add funds, ledger, withdrawals review, donations |
| `event_admin` | Create and manage events |
| `support` | View members, suspend/reactivate, view withdrawals and donations |

## Endpoints

Responses: `{ "data": ..., "meta": { page, pageSize, total, totalPages } }`. Errors: `{ "error": { "code", "message", "details" } }`.
Auth: `Authorization: Bearer <accessToken>` (15 min). Refresh with the refresh token (30 days, single use).
Money-moving POSTs accept an `Idempotency-Key` header.

### Admin – `/api/v1/admin`
| Method | Path | |
|---|---|---|
| POST | `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/change-password` | session |
| GET | `/auth/me` | current admin + permissions |
| GET | `/dashboard` | key metrics, live events, recent transactions |
| GET/POST | `/events` | list (`status`, `q`, `page`) / create (`publish: true` to go live) |
| GET/PATCH | `/events/:id` | detail with entries, stats, settlement report / edit |
| POST | `/events/:id/publish` · `/pause` · `/resume` · `/cancel` | status changes |
| POST/DELETE | `/events/:id/images` · `/events/:id/images/:imageId` | pictures (multipart field `images`, JPEG/PNG/WebP, 5 MB, max 10) |
| GET | `/users`, `/users/:id` | members with wallet and full history |
| POST | `/users/:id/suspend` · `/reactivate` · `/flag` · `/unflag` | |
| GET | `/finance/summary`, `/finance/reconciliation`, `/transactions` | |
| POST | `/finance/fund` | add funds to the main fund |
| GET | `/withdrawals`, `/withdrawals/:id` | |
| POST | `/withdrawals/:id/approve` · `/reject` | for withdrawals on hold |
| GET | `/donations` | donated fund, donors, donations |
| GET/PUT | `/settings` | default radius, GPS accuracy, withdrawal limits… |
| GET | `/audit-logs` | |
| GET/POST/PATCH | `/admins`, `/admins/:id` | super admin only |

### Mobile app – `/api/v1`
| Method | Path | |
|---|---|---|
| POST | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` | |
| GET/PATCH | `/me` | profile |
| POST | `/me/password`, `/me/location` | |
| GET | `/events?lat=&lng=&radiusKm=&filter=active\|upcoming` | live and upcoming events, nearest first |
| GET | `/events/:id` | detail + my entry |
| POST | `/events/:id/participate` | `{ latitude, longitude, accuracyMeters, isMockLocation }` |
| GET | `/me/participations`, `/me/wallet`, `/me/transactions` | |
| GET/PUT | `/me/payout-account` | PayPal email or bank (last 4 digits only) |
| GET/POST | `/me/withdrawals`, `/me/donations` | |
| GET | `/me/referrals` | invite code, invite link and friends who joined |
| POST | `/auth/social` | Google / Apple sign-in. `SOCIAL_AUTH_MODE=mock` (default, local only) trusts the email sent by the app |
| POST | `/auth/forgot-password`, `/auth/reset-password` | 6-digit code, 15 min, single use |
| POST | `/auth/verify-email`, `/auth/resend-verification` | email verification code |
| POST | `/me/avatar` | profile picture (multipart field `avatar`) |
| DELETE | `/me` | `{ confirm: "DELETE" }`; wallet must be empty |
| GET | `/me/notifications`, `/me/notifications/unread-count` | in-app notifications |
| POST | `/me/notifications/read-all`, `/me/notifications/:id/read` | |
| GET | `/app/config` | public: limits, invite base URL, versions |

### Notifications
Created automatically (inside the same database transaction) when: an event is published (to every active member), an entry is accepted, an event settles (winner / not winner), a withdrawal completes / fails / is held / is declined, a donation is made, a password is reset, and on sign-up. Push delivery (FCM) will reuse the same rows.

### Test mode (no email or provider keys yet)
While `NODE_ENV` is not `production`, verification and reset codes are returned in the API response (`devVerificationCode` / `devCode`) so the app can show them. Set `EXPOSE_DEV_CODES=false` to turn this off. `SOCIAL_AUTH_MODE=mock` is refused in production.

## Not built yet (next phases)

Real Google/Apple token verification, sending emails, push notifications (FCM), real PayPal integration and an OpenAPI/Swagger file.
