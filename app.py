"""Concert Hub API: Flask port of the supplied Go ticketing package.

Demo limitations: in-memory data and simulated payments. Do not use as-is for
real money or production deployment. Run with: flask --app app run --debug
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import wraps
from typing import Any, Callable

from flask import Flask, jsonify, request, send_from_directory

HOLD_TTL = timedelta(minutes=2)
MAX_PER_USER = 6
ROWS, COLS, VIP_ROWS = 5, 10, 2
MAX_BODY_BYTES = 64 * 1024


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def token() -> str:
    return secrets.token_hex(16)


def iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def password_hash(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    # scrypt is materially safer than the SHA-256 password hash in the Go sample.
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return salt.hex(), digest.hex()


@dataclass
class User:
    id: int
    name: str
    email: str
    role: str
    salt: str = field(repr=False)
    password_digest: str = field(repr=False)

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "email": self.email, "role": self.role}


@dataclass
class Seat:
    id: str
    tier: str
    price: int
    status: str = "free"
    owner_id: int = 0
    hold_id: str = ""
    held_until: datetime | None = None

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "tier": self.tier, "price": self.price, "status": self.status}


@dataclass
class Concert:
    id: int
    name: str
    venue: str
    date: datetime
    status: str = "active"
    grid: list[list[Seat]] = field(default_factory=list)
    seats: dict[str, Seat] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "venue": self.venue,
                "date": iso(self.date), "status": self.status}


@dataclass
class Hold:
    id: str
    user_id: int
    concert_id: int
    seat_ids: list[str]
    expires: datetime
    booking_id: int = 0


@dataclass
class Ticket:
    id: str
    concert_id: int
    seat_id: str
    tier: str
    price: int
    status: str
    code: str

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "concertId": self.concert_id, "seat": self.seat_id,
                "tier": self.tier, "price": self.price, "status": self.status, "code": self.code}


@dataclass
class Booking:
    id: int
    user_id: int
    concert_id: int
    tickets: list[Ticket]
    total: int
    status: str = "paid"
    refund: int = 0

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "concertId": self.concert_id,
                "tickets": [t.public() for t in self.tickets], "total": self.total,
                "status": self.status, "refund": self.refund}


class ConcertHub:
    def __init__(self, clock: Callable[[], datetime] = utc_now, secret: bytes | None = None):
        self.lock = threading.RLock()
        self.now = clock
        self.secret = secret or secrets.token_bytes(32)
        self.next_id = 0
        self.users: dict[int, User] = {}
        self.by_email: dict[str, User] = {}
        self.sessions: dict[str, int] = {}
        self.concerts: dict[int, Concert] = {}
        self.holds: dict[str, Hold] = {}
        self.bookings: dict[int, Booking] = {}
        self.tickets: dict[str, Ticket] = {}
        self._add_user("Admin", "admin@concerthub.test", "admin12345", "admin")
        self._add_user("Gate Staff", "staff@concerthub.test", "staff12345", "staff")
        self._add_concert("Burna Live", "Eko Convention Centre", self.now() + timedelta(days=30), 25000)
        self._add_concert("Wizkid Night", "Landmark Beach", self.now() + timedelta(days=10), 40000)

    def _id(self) -> int:
        self.next_id += 1
        return self.next_id

    def _add_user(self, name: str, email: str, password: str, role: str) -> User:
        salt, digest = password_hash(password)
        user = User(self._id(), name, email, role, salt, digest)
        self.users[user.id] = user
        self.by_email[email] = user
        return user

    def _add_concert(self, name: str, venue: str, date: datetime, base_price: int) -> Concert:
        concert = Concert(self._id(), name, venue, date.astimezone(timezone.utc))
        for r in range(ROWS):
            tier = "VIP" if r < VIP_ROWS else "Regular"
            price = base_price * 2 if tier == "VIP" else base_price
            row: list[Seat] = []
            for c in range(COLS):
                seat = Seat(f"{chr(65+r)}{c+1}", tier, price)
                row.append(seat)
                concert.seats[seat.id] = seat
            concert.grid.append(row)
        self.concerts[concert.id] = concert
        return concert

    def sign(self, ticket_id: str) -> str:
        return hmac.new(self.secret, ticket_id.encode(), hashlib.sha256).hexdigest()[:12]

    def sweep(self, concert: Concert) -> None:
        now = self.now()
        for seat in concert.seats.values():
            if seat.status == "held" and (seat.held_until is None or now >= seat.held_until):
                seat.status, seat.owner_id, seat.hold_id, seat.held_until = "free", 0, "", None

    def is_open(self, concert: Concert) -> bool:
        return concert.status == "active" and self.now() < concert.date

    @staticmethod
    def refund_pct(until: timedelta) -> int:
        if until >= timedelta(days=7):
            return 100
        if until >= timedelta(hours=48):
            return 50
        return 0

    def release(self, booking: Booking, concert: Concert, pct: int) -> None:
        for ticket in booking.tickets:
            ticket.status = "cancelled"
            seat = concert.seats.get(ticket.seat_id)
            if seat:
                seat.status, seat.owner_id, seat.hold_id, seat.held_until = "free", 0, "", None
        booking.status = "cancelled"
        booking.refund = booking.total * pct // 100


def create_app(testing: bool = False, clock: Callable[[], datetime] = utc_now) -> Flask:
    app = Flask(__name__, static_folder="static")
    app.config.update(TESTING=testing, MAX_CONTENT_LENGTH=MAX_BODY_BYTES)
    hub = ConcertHub(clock=clock)
    app.extensions["concert_hub"] = hub

    @app.errorhandler(413)
    def too_large(_error: Exception):
        return jsonify(error="request body too large"), 413

    @app.errorhandler(400)
    def bad_request(_error: Exception):
        return jsonify(error="invalid request"), 400

    def body() -> dict[str, Any] | None:
        if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
            return None
        if not request.is_json:
            return None
        try:
            data = request.get_json(silent=False)
        except (BadRequestLike, Exception):
            return None
        return data if isinstance(data, dict) else None

    # Keep error handling independent of Werkzeug's specific exception class.
    def read_body() -> tuple[dict[str, Any] | None, Any | None]:
        if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
            return None, (jsonify(error="request body too large"), 413)
        if not request.is_json:
            return None, (jsonify(error="Content-Type must be application/json"), 400)
        try:
            data = request.get_json(silent=False)
        except Exception:
            return None, (jsonify(error="invalid JSON body"), 400)
        if not isinstance(data, dict):
            return None, (jsonify(error="JSON body must be an object"), 400)
        return data, None

    def fail(message: str, status: int):
        return jsonify(error=message), status

    def current_user(roles: tuple[str, ...] = ()) -> tuple[User | None, Any | None]:
        header = request.headers.get("Authorization", "")
        scheme, _, tok = header.partition(" ")
        if scheme.lower() != "bearer" or not tok.strip():
            return None, fail("login required", 401)
        user_id = hub.sessions.get(tok.strip())
        user = hub.users.get(user_id) if user_id is not None else None
        if user is None:
            return None, fail("login required", 401)
        if roles and user.role not in roles:
            return None, fail("you are not allowed to do this", 403)
        return user, None

    def concert_from_path() -> tuple[Concert | None, Any | None]:
        raw = request.view_args.get("id") if request.view_args else None
        try:
            cid = int(raw)
        except (ValueError, TypeError):
            return None, fail("concert not found", 404)
        concert = hub.concerts.get(cid)
        return (concert, None) if concert else (None, fail("concert not found", 404))

    @app.post("/api/register")
    def register():
        data, error = read_body()
        if error: return error
        name, email, password = data.get("name"), data.get("email"), data.get("password")
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            return fail("name, valid email and a password of 8+ characters are required", 400)
        if not isinstance(email, str):
            return fail("name, valid email and a password of 8+ characters are required", 400)
        email = email.strip().casefold()
        if len(email) > 254 or email.count("@") != 1 or any(ch.isspace() for ch in email):
            return fail("name, valid email and a password of 8+ characters are required", 400)
        local, domain = email.split("@")
        if not local or not domain or "." not in domain or domain.startswith(".") or domain.endswith("."):
            return fail("name, valid email and a password of 8+ characters are required", 400)
        if not isinstance(password, str) or len(password) < 8 or len(password) > 1024:
            return fail("name, valid email and a password of 8+ characters are required", 400)
        with hub.lock:
            if email in hub.by_email:
                return fail("email already registered", 409)
            user = hub._add_user(name.strip(), email, password, "customer")
            return jsonify(user.public()), 201

    @app.post("/api/login")
    def login():
        data, error = read_body()
        if error: return error
        email, password = data.get("email"), data.get("password")
        if not isinstance(email, str) or not isinstance(password, str):
            return fail("wrong email or password", 401)
        with hub.lock:
            user = hub.by_email.get(email.strip().casefold())
            valid = False
            if user is not None:
                try:
                    candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(user.salt), n=2**14, r=8, p=1).hex()
                    valid = hmac.compare_digest(user.password_digest, candidate)
                except (ValueError, UnicodeError):
                    valid = False
            if not valid or user is None:
                return fail("wrong email or password", 401)
            session = token()
            hub.sessions[session] = user.id
            return jsonify(token=session, user=user.public()), 200

    @app.get("/api/concerts")
    def list_concerts():
        with hub.lock:
            return jsonify([c.public() for c in sorted(hub.concerts.values(), key=lambda x: x.date)]), 200

    @app.get("/api/concerts/<id>/seats")
    def get_seats(id: str):
        with hub.lock:
            try: concert = hub.concerts.get(int(id))
            except ValueError: concert = None
            if concert is None: return fail("concert not found", 404)
            hub.sweep(concert)
            return jsonify([[seat.public() for seat in row] for row in concert.grid]), 200

    @app.get("/api/concerts/<id>/suggest")
    def suggest(id: str):
        raw_n = request.args.get("n", "")
        try: n = int(raw_n)
        except (ValueError, TypeError): n = 2
        if not 1 <= n <= COLS: n = 2
        with hub.lock:
            try: concert = hub.concerts.get(int(id))
            except ValueError: concert = None
            if concert is None: return fail("concert not found", 404)
            hub.sweep(concert)
            best_score, best = None, None
            for ri, row in enumerate(concert.grid):
                for start in range(COLS - n + 1):
                    group = row[start:start+n]
                    if all(seat.status == "free" for seat in group):
                        offset = abs(2 * start + n - 1 - (COLS - 1))
                        score = ri * 10 + offset
                        if best_score is None or score < best_score:
                            best_score, best = score, [seat.id for seat in group]
            if best is None: return fail("no adjacent seats found", 404)
            return jsonify(seats=best), 200

    @app.post("/api/concerts/<id>/hold")
    def hold_seats(id: str):
        data, error = read_body()
        if error: return error
        seat_ids = data.get("seats")
        if not isinstance(seat_ids, list) or not 1 <= len(seat_ids) <= MAX_PER_USER:
            return fail("choose between 1 and 6 seats", 400)
        if any(not isinstance(s, str) or not s.strip() for s in seat_ids):
            return fail("seat IDs must be non-empty strings", 400)
        seat_ids = [s.strip().upper() for s in seat_ids]
        with hub.lock:
            user, error = current_user()
            if error: return error
            try: concert = hub.concerts.get(int(id))
            except ValueError: concert = None
            if concert is None: return fail("concert not found", 404)
            if not hub.is_open(concert): return fail("this concert is not open for booking", 409)
            hub.sweep(concert)
            owned = sum(1 for seat in concert.seats.values() if seat.owner_id == user.id and seat.status in ("held", "booked"))
            if owned + len(seat_ids) > MAX_PER_USER:
                return fail("limit is 6 tickets per person per concert", 409)
            seen: set[str] = set()
            chosen: list[Seat] = []
            for sid in seat_ids:
                seat = concert.seats.get(sid)
                if seat is None: return fail(f"unknown seat {sid}", 400)
                if sid in seen: return fail(f"duplicate seat {sid}", 400)
                if seat.status != "free": return fail(f"seat {sid} is not available", 409)
                seen.add(sid); chosen.append(seat)
            total = sum(seat.price for seat in chosen)
            expires = hub.now() + HOLD_TTL
            hold = Hold(token(), user.id, concert.id, seat_ids, expires)
            hub.holds[hold.id] = hold
            for seat in chosen:
                seat.status, seat.owner_id, seat.hold_id, seat.held_until = "held", user.id, hold.id, expires
            return jsonify(holdId=hold.id, expiresAt=iso(expires), total=total), 200

    @app.post("/api/holds/<hold_id>/pay")
    def pay(hold_id: str):
        data, error = read_body()
        if error: return error
        card_token = data.get("cardToken")
        if not isinstance(card_token, str): card_token = ""
        with hub.lock:
            user, error = current_user()
            if error: return error
            hold = hub.holds.get(hold_id)
            if hold is None or hold.user_id != user.id: return fail("hold not found", 404)
            if hold.booking_id:
                return jsonify(hub.bookings[hold.booking_id].public()), 200
            concert = hub.concerts.get(hold.concert_id)
            if concert is None: return fail("concert not found", 404)
            hub.sweep(concert)
            if hub.now() >= hold.expires: return fail("hold expired, please select your seats again", 410)
            if not hub.is_open(concert): return fail("this concert is no longer open for booking", 409)
            chosen = []
            for sid in hold.seat_ids:
                seat = concert.seats.get(sid)
                if seat is None or seat.status != "held" or seat.hold_id != hold.id or seat.owner_id != user.id:
                    return fail("hold is no longer valid", 410)
                chosen.append(seat)
            total = sum(seat.price for seat in chosen)
            if not card_token.strip(): return fail("card token required", 402)
            if card_token == "fail": return fail("card declined", 402)
            booking = Booking(hub._id(), user.id, concert.id, [], total)
            for seat in chosen:
                seat.status = "booked"
                tid = token()
                ticket = Ticket(tid, concert.id, seat.id, seat.tier, seat.price, "valid", f"{tid}.{hub.sign(tid)}")
                hub.tickets[tid] = ticket
                booking.tickets.append(ticket)
            hub.bookings[booking.id] = booking
            hold.booking_id = booking.id
            return jsonify(booking.public()), 201

    @app.get("/api/bookings")
    def my_bookings():
        with hub.lock:
            user, error = current_user()
            if error: return error
            bookings = sorted((b for b in hub.bookings.values() if b.user_id == user.id), key=lambda b: b.id)
            return jsonify([b.public() for b in bookings]), 200

    @app.post("/api/bookings/<id>/cancel")
    def cancel_booking(id: str):
        with hub.lock:
            user, error = current_user()
            if error: return error
            try: bid = int(id)
            except ValueError: bid = -1
            booking = hub.bookings.get(bid)
            if booking is None or booking.user_id != user.id: return fail("booking not found", 404)
            if booking.status != "paid": return fail("booking is already cancelled", 409)
            concert = hub.concerts.get(booking.concert_id)
            if concert is None: return fail("concert not found", 404)
            until = concert.date - hub.now()
            if until <= timedelta(0): return fail("the event has already started", 409)
            if any(t.status == "used" for t in booking.tickets): return fail("tickets already used", 409)
            hub.release(booking, concert, hub.refund_pct(until))
            return jsonify(booking.public()), 200

    @app.post("/api/admin/concerts")
    def admin_create():
        data, error = read_body()
        if error: return error
        name, venue = data.get("name"), data.get("venue")
        date = parse_datetime(data.get("date"))
        base = data.get("basePrice")
        if (not isinstance(name, str) or not name.strip() or len(name.strip()) > 200 or
            not isinstance(venue, str) or not venue.strip() or len(venue.strip()) > 200 or
            isinstance(base, bool) or not isinstance(base, int) or base <= 0 or base > 2_000_000_000 or
            date is None or date <= hub.now()):
            return fail("name, venue, positive basePrice and a future date (RFC3339) are required", 400)
        with hub.lock:
            user, error = current_user(("admin",))
            if error: return error
            concert = hub._add_concert(name.strip(), venue.strip(), date, base)
            return jsonify(concert.public()), 201

    @app.post("/api/admin/concerts/<id>/cancel")
    def admin_cancel(id: str):
        with hub.lock:
            user, error = current_user(("admin",))
            if error: return error
            try: concert = hub.concerts.get(int(id))
            except ValueError: concert = None
            if concert is None: return fail("concert not found", 404)
            if concert.status == "cancelled": return fail("concert is already cancelled", 409)
            concert.status = "cancelled"
            refunded = 0
            for booking in hub.bookings.values():
                if booking.concert_id == concert.id and booking.status == "paid":
                    hub.release(booking, concert, 100)
                    refunded += booking.refund
            # Expire any remaining holds immediately by freeing their seats.
            for seat in concert.seats.values():
                if seat.status == "held":
                    seat.status, seat.owner_id, seat.hold_id, seat.held_until = "free", 0, "", None
            return jsonify(status="cancelled", refunded=refunded), 200

    @app.get("/api/admin/concerts/<id>/report")
    def report(id: str):
        with hub.lock:
            user, error = current_user(("admin",))
            if error: return error
            try: concert = hub.concerts.get(int(id))
            except ValueError: concert = None
            if concert is None: return fail("concert not found", 404)
            sold: dict[str, int] = {}
            used = revenue = 0
            for booking in hub.bookings.values():
                if booking.concert_id != concert.id: continue
                revenue += booking.total - booking.refund
                for ticket in booking.tickets:
                    if ticket.status != "cancelled": sold[ticket.tier] = sold.get(ticket.tier, 0) + 1
                    if ticket.status == "used": used += 1
            return jsonify(concert=concert.name, soldByTier=sold, checkedIn=used, revenue=revenue), 200

    @app.post("/api/validate")
    def validate_ticket():
        data, error = read_body()
        if error: return error
        code = data.get("code")
        if not isinstance(code, str) or not code or len(code) > 256:
            return fail("invalid ticket code", 400)
        with hub.lock:
            user, error = current_user(("staff", "admin"))
            if error: return error
            if code.count(".") != 1:
                return fail("invalid ticket code", 400)
            tid, signature = code.split(".", 1)
            if not tid or not signature or not hmac.compare_digest(signature, hub.sign(tid)):
                return fail("invalid ticket code", 400)
            ticket = hub.tickets.get(tid)
            if ticket is None: return fail("ticket not found", 404)
            concert = hub.concerts.get(ticket.concert_id)
            if concert is None: return fail("concert not found", 404)
            now = hub.now()
            if ticket.status == "used": return fail("ticket already used", 409)
            if ticket.status == "cancelled" or concert.status == "cancelled": return fail("ticket was cancelled", 409)
            if now < concert.date - timedelta(hours=3): return fail("doors are not open yet", 409)
            if now > concert.date + timedelta(hours=8): return fail("event is over", 409)
            ticket.status = "used"
            return jsonify(valid=True, seat=ticket.seat_id, tier=ticket.tier, concert=concert.name), 200

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    return app


# Flask is imported above; this alias keeps body parsing exceptions portable.
BadRequestLike = ValueError
app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
