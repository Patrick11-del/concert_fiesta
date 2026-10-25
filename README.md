# Concert Hub — Python / Flask port

A Python implementation of the provided Go ticketing API. It keeps the same main routes and rules while improving input validation, password hashing, token generation, and public data serialization.

## Requirements
- Python 3.12+ recommended
- Flask 3.x

## Run locally

From the `concert_hub_python` project folder:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python app.py
```

API is available at `http://127.0.0.1:5000`.

## Demo accounts
- Admin: `admin@concerthub.test` / `admin12345`
- Gate staff: `staff@concerthub.test` / `staff12345`

Register ordinary customer accounts through `POST /api/register`.

## API routes
- `POST /api/register`
- `POST /api/login`
- `GET /api/concerts`
- `GET /api/concerts/<id>/seats`
- `GET /api/concerts/<id>/suggest?n=2`
- `POST /api/concerts/<id>/hold`
- `POST /api/holds/<holdId>/pay`
- `GET /api/bookings`
- `POST /api/bookings/<id>/cancel`
- `POST /api/admin/concerts`
- `POST /api/admin/concerts/<id>/cancel`
- `GET /api/admin/concerts/<id>/report`
- `POST /api/validate`

Authenticated endpoints use `Authorization: Bearer <token>`. JSON request bodies are required where applicable.

## Example workflow

1. `POST /api/login` with `{"email":"admin@concerthub.test","password":"admin12345"}` to test admin access, or register/login a customer.
2. `GET /api/concerts` to get concert IDs.
3. `POST /api/concerts/3/hold` with `{"seats":["C4","C5"]}` and the customer's bearer token (replace `3` with the actual concert ID).
4. `POST /api/holds/<holdId>/pay` with `{"cardToken":"demo-card"}`.
5. `GET /api/bookings` to see the user's bookings.

A card token of `fail` simulates a declined payment. Any other non-empty token simulates success; no real money is charged.

## Important limitations
- Storage is in memory; restarting the process loses accounts, sessions, holds, bookings, and tickets.
- Payments are simulated. Integrate a real provider and verify server-side payment events before accepting real money.
- The in-process lock protects concurrent requests within one Python process only. Use database transactions and distributed-safe locking for multiple workers.
- Ticket codes are signed, but there is no QR image generation in this API; the `code` field is the QR payload.
- The app is an API-first backend. `static/index.html` is a placeholder; no frontend was included in the supplied Go code itself.

## Security notes
The Go code's demo SHA-256 password hash was replaced with Python `scrypt`; password hashes and salts are not returned by the API. Before production, add rate limiting, email verification, password reset, HTTPS, persistent database storage, session expiry/revocation, CSRF protections if cookie auth is introduced, and a real payment integration.
