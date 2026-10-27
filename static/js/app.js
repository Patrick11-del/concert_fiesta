/* Concert Fiesta frontend. API contracts are defined by app.py. */
(() => {
    "use strict";

    const byId = (id) => document.getElementById(id);
    const SESSION_TOKEN_KEY = "concertFiestaToken";
    const SESSION_USER_KEY = "concertFiestaUser";
    const MAX_SEATS = 6;

    const ICONS = {
        pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
        calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
        ticket: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M13 8v2m0 2v2m0 2v1"/></svg>',
        arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
    };

    class ApiError extends Error {
        constructor(message, status = 0) {
            super(message);
            this.name = "ApiError";
            this.status = status;
        }
    }

    function loadStoredUser() {
        try {
            const value = sessionStorage.getItem(SESSION_USER_KEY);
            return value ? JSON.parse(value) : null;
        } catch (_error) {
            sessionStorage.removeItem(SESSION_USER_KEY);
            return null;
        }
    }

    const state = {
        concerts: [],
        selectedConcert: null,
        seatRows: [],
        seatById: new Map(),
        selectedSeatIds: new Set(),
        token: sessionStorage.getItem(SESSION_TOKEN_KEY) || "",
        user: loadStoredUser(),
        authMode: "login",
        authReturnTarget: "checkout",
        hold: null,
        holdTimerId: null,
        holdExpiredHandling: false,
    };

    async function apiRequest(url, options = {}) {
        const headers = new Headers(options.headers || {});
        const requestOptions = { ...options, headers, cache: "no-store" };

        if (state.token) {
            headers.set("Authorization", `Bearer ${state.token}`);
        }
        if (options.body !== undefined && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        let response;
        try {
            response = await fetch(url, requestOptions);
        } catch (_error) {
            throw new ApiError("Could not reach the server. Check that Flask is running and try again.");
        }

        const responseText = await response.text();
        let data = null;
        if (responseText) {
            try {
                data = JSON.parse(responseText);
            } catch (_error) {
                data = null;
            }
        }

        if (!response.ok) {
            const fallback = `The request failed (${response.status}). Please try again.`;
            throw new ApiError((data && typeof data.error === "string" && data.error) || fallback, response.status);
        }
        return data;
    }

    function setNotice(element, message, kind = "info") {
        if (!element) return;
        element.textContent = message || "";
        element.classList.remove("notice--success", "notice--error");
        if (kind === "success") element.classList.add("notice--success");
        if (kind === "error") element.classList.add("notice--error");
    }

    function formatMoney(value) {
        const amount = Number(value);
        return new Intl.NumberFormat("en-NG", {
            style: "currency",
            currency: "NGN",
            maximumFractionDigits: 0,
        }).format(Number.isFinite(amount) ? amount : 0);
    }

    function formatDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Date to be announced";
        return new Intl.DateTimeFormat("en-NG", {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(date);
    }

    function createIconLine(iconName, text) {
        const line = document.createElement("span");
        const iconWrap = document.createElement("span");
        iconWrap.className = "icon-inline";
        iconWrap.innerHTML = ICONS[iconName] || ICONS.ticket;
        const textNode = document.createElement("span");
        textNode.textContent = text;
        line.append(iconWrap, textNode);
        return line;
    }

    function updateAccountUI() {
        const label = byId("account-label");
        const logout = byId("logout-button");
        label.textContent = state.user && state.user.name ? state.user.name : "Guest";
        logout.hidden = !state.token;
    }

    function saveSession(data) {
        state.token = data.token;
        state.user = data.user;
        sessionStorage.setItem(SESSION_TOKEN_KEY, data.token);
        sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(data.user));
        updateAccountUI();
    }

    function clearSession() {
        state.token = "";
        state.user = null;
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        sessionStorage.removeItem(SESSION_USER_KEY);
        updateAccountUI();
    }

    function handleUnauthorized() {
        clearSession();
        setNotice(byId("auth-message"), "Your session is no longer valid. Please log in again.", "error");
        showAuthPanel("bookings");
    }

    function renderConcerts() {
        const list = byId("concert-list");
        list.replaceChildren();

        if (!state.concerts.length) {
            setNotice(byId("concert-status"), "No concerts are available right now.");
            return;
        }

        setNotice(byId("concert-status"), `${state.concerts.length} live experience${state.concerts.length === 1 ? "" : "s"} to explore.`);
        state.concerts.forEach((concert, index) => {
            const card = document.createElement("article");
            card.className = "concert-card";

            const topline = document.createElement("div");
            topline.className = "concert-card__topline";
            const tag = document.createElement("span");
            tag.className = "concert-card__tag";
            tag.innerHTML = ICONS.ticket;
            const tagText = document.createElement("span");
            tagText.textContent = concert.status === "cancelled" ? "Cancelled event" : "Live event";
            tag.appendChild(tagText);
            const sequence = document.createElement("span");
            sequence.className = "concert-card__sequence";
            sequence.textContent = `CF / ${String(index + 1).padStart(2, "0")}`;
            topline.append(tag, sequence);

            const name = document.createElement("h3");
            name.textContent = concert.name || "Untitled concert";

            const meta = document.createElement("div");
            meta.className = "concert-card__meta";
            meta.append(
                createIconLine("pin", concert.venue || "Venue to be announced"),
                createIconLine("calendar", formatDate(concert.date)),
            );

            const footer = document.createElement("div");
            footer.className = "concert-card__footer";
            const hint = document.createElement("span");
            hint.className = "concert-card__hint";
            hint.textContent = concert.status === "cancelled" ? "Booking unavailable" : "Seat map available";

            const button = document.createElement("button");
            button.type = "button";
            button.className = "button button--primary";
            button.append(document.createTextNode(concert.status === "cancelled" ? "Unavailable" : "Choose seats"));
            if (concert.status === "cancelled" || new Date(concert.date).getTime() <= Date.now()) {
                button.disabled = true;
            } else {
                button.append(document.createTextNode(" "));
                const arrowHolder = document.createElement("span");
                arrowHolder.innerHTML = ICONS.arrow;
                button.appendChild(arrowHolder);
                button.addEventListener("click", () => openSeatPicker(concert));
            }

            footer.append(hint, button);
            card.append(topline, name, meta, footer);
            list.appendChild(card);
        });
    }

    async function loadConcerts() {
        setNotice(byId("concert-status"), "Loading concerts…");
        try {
            const result = await apiRequest("/api/concerts");
            if (!Array.isArray(result)) throw new ApiError("The concert list returned an unexpected response.");
            state.concerts = result;
            renderConcerts();
        } catch (error) {
            setNotice(byId("concert-status"), error.message, "error");
            byId("concert-list").replaceChildren();
            console.error("Concert list failed:", error);
        }
    }

    async function openSeatPicker(concert) {
        if (state.hold) {
            const expiresAt = new Date(state.hold.expiresAt).getTime();
            if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
                setNotice(byId("payment-message"), "Finish this checkout or wait for the temporary hold to expire before choosing another concert.", "error");
                byId("payment-panel").hidden = false;
                byId("payment-panel").scrollIntoView({ behavior: "smooth", block: "start" });
                return;
            }
            await expireHold(true);
        }

        state.selectedConcert = concert;
        state.selectedSeatIds.clear();
        byId("selected-concert-name").textContent = `${concert.name} — ${concert.venue}`;
        byId("seat-selection").hidden = false;
        byId("auth-panel").hidden = true;
        byId("payment-panel").hidden = true;
        byId("booking-confirmation").hidden = true;
        setNotice(byId("seat-message"), "Loading the current seat map…");
        updateSelectionSummary();
        byId("seat-selection").scrollIntoView({ behavior: "smooth", block: "start" });
        await loadSeats(concert.id);
    }

    async function loadSeats(concertId) {
        try {
            const rows = await apiRequest(`/api/concerts/${encodeURIComponent(concertId)}/seats`);
            if (!Array.isArray(rows) || !rows.every(Array.isArray)) {
                throw new ApiError("The seat map returned an unexpected response.");
            }
            state.seatRows = rows;
            state.seatById.clear();
            rows.flat().forEach((seat) => state.seatById.set(seat.id, seat));
            renderSeatMap();
            setNotice(byId("seat-message"), "Choose available seats. VIP seats are priced separately from Regular seats.");
            updateSelectionSummary();
        } catch (error) {
            byId("seat-grid").replaceChildren();
            setNotice(byId("seat-message"), error.message, "error");
            console.error("Seat map failed:", error);
            if (error.status === 401) handleUnauthorized();
        }
    }

    function renderSeatMap() {
        const seatGrid = byId("seat-grid");
        seatGrid.replaceChildren();

        state.seatRows.forEach((row, rowIndex) => {
            const rowElement = document.createElement("div");
            rowElement.className = "seat-map__row";
            const rowLabel = document.createElement("span");
            rowLabel.className = "seat-map__row-label";
            rowLabel.textContent = row[0] && row[0].id ? row[0].id.charAt(0) : String.fromCharCode(65 + rowIndex);
            const seats = document.createElement("div");
            seats.className = "seat-map__seats";

            row.forEach((seat) => {
                const button = document.createElement("button");
                const isSelected = state.selectedSeatIds.has(seat.id);
                const isAvailable = seat.status === "free";
                button.type = "button";
                button.className = `seat${seat.tier === "VIP" ? " seat--vip" : ""}${isSelected ? " seat--selected" : ""}${!isAvailable ? " seat--unavailable" : ""}`;
                button.textContent = seat.id;
                button.title = `${seat.id} · ${seat.tier} · ${formatMoney(seat.price)} · ${seat.status}`;
                button.setAttribute("aria-label", `Seat ${seat.id}, ${seat.tier}, ${formatMoney(seat.price)}, ${seat.status}`);
                button.setAttribute("aria-pressed", String(isSelected));
                button.disabled = !isAvailable || Boolean(state.hold);
                if (isAvailable && !state.hold) {
                    button.addEventListener("click", () => toggleSeat(seat.id));
                }
                seats.appendChild(button);
            });

            rowElement.append(rowLabel, seats);
            seatGrid.appendChild(rowElement);
        });
    }

    function toggleSeat(seatId) {
        if (state.hold) return;
        const seat = state.seatById.get(seatId);
        if (!seat || seat.status !== "free") return;

        if (state.selectedSeatIds.has(seatId)) {
            state.selectedSeatIds.delete(seatId);
        } else {
            if (state.selectedSeatIds.size >= MAX_SEATS) {
                setNotice(byId("seat-message"), "You can select up to 6 seats for one concert. Remove a seat before adding another.", "error");
                return;
            }
            state.selectedSeatIds.add(seatId);
        }
        renderSeatMap();
        updateSelectionSummary();
        setNotice(byId("seat-message"), `${state.selectedSeatIds.size} of ${MAX_SEATS} seats selected.`);
    }

    function updateSelectionSummary() {
        const chosen = [...state.selectedSeatIds]
            .map((seatId) => state.seatById.get(seatId))
            .filter(Boolean);
        const total = chosen.reduce((sum, seat) => sum + Number(seat.price || 0), 0);
        byId("selected-seat-count").textContent = String(chosen.length);
        byId("seat-total").textContent = formatMoney(total);
        byId("selected-seat-list").textContent = chosen.length
            ? chosen.map((seat) => `${seat.id} (${seat.tier})`).join(", ")
            : "No seats selected yet";
        byId("continue-checkout-button").disabled = chosen.length === 0 || Boolean(state.hold);
    }

    async function suggestAdjacentSeats() {
        if (!state.selectedConcert) {
            setNotice(byId("seat-message"), "Choose a concert before asking for a seat suggestion.", "error");
            return;
        }
        if (state.hold) {
            setNotice(byId("seat-message"), "Your current seats are on hold. Complete checkout or let the hold expire first.", "error");
            return;
        }

        const button = byId("suggest-seats-button");
        button.disabled = true;
        try {
            const suggestion = await apiRequest(`/api/concerts/${encodeURIComponent(state.selectedConcert.id)}/suggest?n=2`);
            if (!suggestion || !Array.isArray(suggestion.seats) || suggestion.seats.length === 0) {
                throw new ApiError("No adjacent seats are currently available.");
            }
            state.selectedSeatIds = new Set(suggestion.seats.filter((id) => {
                const seat = state.seatById.get(id);
                return seat && seat.status === "free";
            }));
            renderSeatMap();
            updateSelectionSummary();
            setNotice(byId("seat-message"), `Suggested adjacent seats: ${[...state.selectedSeatIds].join(", ")}. You can change the selection before checkout.`, "success");
        } catch (error) {
            setNotice(byId("seat-message"), error.message, "error");
        } finally {
            button.disabled = false;
        }
    }

    function showAuthPanel(returnTarget = "checkout") {
        state.authReturnTarget = returnTarget;
        byId("auth-panel").hidden = false;
        byId("auth-panel").scrollIntoView({ behavior: "smooth", block: "start" });
        byId("auth-email").focus({ preventScroll: true });
    }

    function setAuthMode(mode) {
        state.authMode = mode === "register" ? "register" : "login";
        const registering = state.authMode === "register";
        byId("name-field").hidden = !registering;
        byId("auth-name").required = registering;
        byId("auth-password").setAttribute("autocomplete", registering ? "new-password" : "current-password");
        byId("auth-title").textContent = registering ? "Create your Concert Fiesta account" : "Sign in to reserve your seats";
        byId("auth-submit-button").textContent = registering ? "Create account and continue" : "Log in and continue";
        document.querySelectorAll("[data-auth-mode]").forEach((button) => {
            const active = button.dataset.authMode === state.authMode;
            button.classList.toggle("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        });
        setNotice(byId("auth-message"), "");
    }

    async function submitAuth(event) {
        event.preventDefault();
        const submitButton = byId("auth-submit-button");
        const form = byId("auth-form");
        if (!form.reportValidity()) return;

        const email = byId("auth-email").value.trim();
        const password = byId("auth-password").value;
        const name = byId("auth-name").value.trim();
        submitButton.disabled = true;
        setNotice(byId("auth-message"), state.authMode === "register" ? "Creating your account…" : "Signing you in…");

        try {
            if (state.authMode === "register") {
                await apiRequest("/api/register", {
                    method: "POST",
                    body: JSON.stringify({ name, email, password }),
                });
            }
            const result = await apiRequest("/api/login", {
                method: "POST",
                body: JSON.stringify({ email, password }),
            });
            if (!result || typeof result.token !== "string" || !result.user) {
                throw new ApiError("The server returned an unexpected login response.");
            }
            saveSession(result);
            byId("auth-panel").hidden = true;
            setNotice(byId("auth-message"), "");

            if (state.authReturnTarget === "bookings") {
                await loadMyBookings();
            } else {
                await beginCheckout();
            }
        } catch (error) {
            setNotice(byId("auth-message"), error.message, "error");
        } finally {
            submitButton.disabled = false;
        }
    }

    async function beginCheckout() {
        if (!state.selectedConcert) {
            setNotice(byId("seat-message"), "Choose a concert first.", "error");
            return;
        }
        if (!state.selectedSeatIds.size) {
            setNotice(byId("seat-message"), "Select at least one available seat before continuing.", "error");
            return;
        }
        if (!state.token) {
            showAuthPanel("checkout");
            setNotice(byId("auth-message"), "Log in or create an account to reserve the selected seats.");
            return;
        }

        const button = byId("continue-checkout-button");
        button.disabled = true;
        setNotice(byId("seat-message"), "Checking seat availability and creating a temporary hold…");
        try {
            const result = await apiRequest(`/api/concerts/${encodeURIComponent(state.selectedConcert.id)}/hold`, {
                method: "POST",
                body: JSON.stringify({ seats: [...state.selectedSeatIds] }),
            });
            if (!result || typeof result.holdId !== "string" || !result.expiresAt) {
                throw new ApiError("The server returned an unexpected hold response.");
            }
            state.hold = {
                id: result.holdId,
                expiresAt: result.expiresAt,
                total: Number(result.total || 0),
            };
            byId("payment-total").textContent = formatMoney(state.hold.total);
            byId("payment-panel").hidden = false;
            byId("booking-confirmation").hidden = true;
            byId("auth-panel").hidden = true;
            byId("card-token").value = "";
            setNotice(byId("payment-message"), "Your seats are temporarily held. Complete the demo checkout before the timer expires.", "success");
            renderSeatMap();
            updateSelectionSummary();
            startHoldCountdown();
            byId("payment-panel").scrollIntoView({ behavior: "smooth", block: "start" });
            byId("card-token").focus({ preventScroll: true });
        } catch (error) {
            setNotice(byId("seat-message"), error.message, "error");
            if (error.status === 401) {
                clearSession();
                showAuthPanel("checkout");
                setNotice(byId("auth-message"), "Please log in again to continue.", "error");
            } else if (error.status === 409) {
                await loadSeats(state.selectedConcert.id);
                setNotice(byId("seat-message"), `${error.message} The seat map has been refreshed; check your selection.`, "error");
            }
        } finally {
            if (!state.hold) button.disabled = state.selectedSeatIds.size === 0;
        }
    }

    function startHoldCountdown() {
        stopHoldTimer();
        updateHoldCountdown();
        state.holdTimerId = window.setInterval(updateHoldCountdown, 1000);
    }

    function stopHoldTimer() {
        if (state.holdTimerId !== null) {
            window.clearInterval(state.holdTimerId);
            state.holdTimerId = null;
        }
    }

    function updateHoldCountdown() {
        if (!state.hold) {
            stopHoldTimer();
            return;
        }
        const expires = new Date(state.hold.expiresAt).getTime();
        const remainingMs = expires - Date.now();
        if (!Number.isFinite(expires) || remainingMs <= 0) {
            void expireHold(false);
            return;
        }
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
        const seconds = String(totalSeconds % 60).padStart(2, "0");
        byId("hold-countdown").textContent = `${minutes}:${seconds}`;
    }

    async function expireHold(silent) {
        if (!state.hold || state.holdExpiredHandling) return;
        state.holdExpiredHandling = true;
        stopHoldTimer();
        state.hold = null;
        state.selectedSeatIds.clear();
        byId("payment-panel").hidden = true;
        updateSelectionSummary();
        if (state.selectedConcert) {
            await loadSeats(state.selectedConcert.id);
        }
        setNotice(byId("seat-message"), silent ? "Your previous hold expired. Select seats again." : "Your temporary hold expired. Select seats again to start a new checkout.", "error");
        state.holdExpiredHandling = false;
    }

    async function submitPayment(event) {
        event.preventDefault();
        const form = byId("payment-form");
        if (!form.reportValidity()) return;
        if (!state.hold) {
            setNotice(byId("payment-message"), "There is no active hold. Select your seats again.", "error");
            return;
        }

        const submitButton = byId("pay-button");
        submitButton.disabled = true;
        setNotice(byId("payment-message"), "Processing the demo payment…");
        try {
            const booking = await apiRequest(`/api/holds/${encodeURIComponent(state.hold.id)}/pay`, {
                method: "POST",
                body: JSON.stringify({ cardToken: byId("card-token").value.trim() }),
            });
            if (!booking || !Array.isArray(booking.tickets)) {
                throw new ApiError("Payment completed, but the booking response was unexpected. Check My bookings before trying again.");
            }
            stopHoldTimer();
            state.hold = null;
            state.selectedSeatIds.clear();
            byId("payment-panel").hidden = true;
            renderBookingConfirmation(booking);
            updateSelectionSummary();
            if (state.selectedConcert) await loadSeats(state.selectedConcert.id);
            await loadMyBookings({ scroll: false, quiet: true });
            byId("booking-confirmation").scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
            setNotice(byId("payment-message"), error.message, "error");
            if (error.status === 401) {
                clearSession();
                showAuthPanel("checkout");
            } else if (error.status === 410) {
                await expireHold(false);
            }
        } finally {
            submitButton.disabled = false;
        }
    }

    function renderBookingConfirmation(booking) {
        const concert = state.concerts.find((item) => item.id === booking.concertId);
        byId("booking-confirmation-copy").textContent = `${concert ? concert.name : "Your concert"} · ${booking.tickets.length} ticket${booking.tickets.length === 1 ? "" : "s"} · Total ${formatMoney(booking.total)}.`;
        const list = byId("booking-ticket-list");
        list.replaceChildren();
        booking.tickets.forEach((ticket) => {
            const card = document.createElement("div");
            card.className = "ticket-code-card";
            const title = document.createElement("strong");
            title.textContent = `Seat ${ticket.seat}`;
            const meta = document.createElement("span");
            meta.textContent = `${ticket.tier} · ${formatMoney(ticket.price)}`;
            const code = document.createElement("code");
            code.textContent = ticket.code;
            card.append(title, meta, code);
            list.appendChild(card);
        });
        byId("booking-confirmation").hidden = false;
    }

    async function loadMyBookings(options = {}) {
        const { scroll = false, quiet = false } = options;
        const message = byId("bookings-message");
        if (!state.token) {
            byId("booking-list").replaceChildren();
            setNotice(message, "Log in or create an account during checkout to view your bookings.");
            state.authReturnTarget = "bookings";
            if (scroll) showAuthPanel("bookings");
            return;
        }

        if (!quiet) setNotice(message, "Loading your bookings…");
        try {
            const bookings = await apiRequest("/api/bookings");
            if (!Array.isArray(bookings)) throw new ApiError("The bookings endpoint returned an unexpected response.");
            renderBookings(bookings);
            setNotice(message, bookings.length ? `${bookings.length} booking record${bookings.length === 1 ? "" : "s"} found.` : "You do not have any bookings yet.");
            if (scroll) byId("my-bookings").scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
            setNotice(message, error.message, "error");
            if (error.status === 401) {
                clearSession();
                state.authReturnTarget = "bookings";
                if (scroll) showAuthPanel("bookings");
            }
        }
    }

    function renderBookings(bookings) {
        const list = byId("booking-list");
        list.replaceChildren();
        if (!bookings.length) return;

        bookings.forEach((booking) => {
            const concert = state.concerts.find((item) => item.id === booking.concertId);
            const card = document.createElement("article");
            card.className = "booking-card";

            const header = document.createElement("div");
            header.className = "booking-card__header";
            const headingWrap = document.createElement("div");
            const title = document.createElement("h3");
            title.textContent = concert ? concert.name : `Concert #${booking.concertId}`;
            const meta = document.createElement("p");
            meta.className = "booking-card__meta";
            meta.textContent = `Booking #${booking.id} · ${booking.tickets.length} ticket${booking.tickets.length === 1 ? "" : "s"}`;
            headingWrap.append(title, meta);
            const status = document.createElement("span");
            status.className = `status-pill ${booking.status === "paid" ? "status-pill--paid" : "status-pill--cancelled"}`;
            status.textContent = booking.status;
            header.append(headingWrap, status);

            const ticketLines = document.createElement("div");
            ticketLines.className = "booking-card__tickets";
            booking.tickets.forEach((ticket) => {
                const line = document.createElement("div");
                line.className = "booking-ticket-line";
                const description = document.createElement("span");
                description.textContent = `Seat ${ticket.seat} · ${ticket.tier}`;
                const amount = document.createElement("strong");
                amount.textContent = formatMoney(ticket.price);
                line.append(description, amount);
                ticketLines.appendChild(line);
            });

            const total = document.createElement("div");
            total.className = "booking-card__total";
            const totalLabel = document.createElement("span");
            totalLabel.textContent = booking.refund ? `Total · Refund ${formatMoney(booking.refund)}` : "Booking total";
            const totalAmount = document.createElement("strong");
            totalAmount.textContent = formatMoney(booking.total);
            total.append(totalLabel, totalAmount);

            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "View ticket codes";
            details.appendChild(summary);
            booking.tickets.forEach((ticket) => {
                const code = document.createElement("p");
                code.className = "booking-card__meta";
                code.textContent = `${ticket.seat}: ${ticket.code}`;
                details.appendChild(code);
            });

            card.append(header, ticketLines, total, details);
            if (booking.status === "paid") {
                const cancel = document.createElement("button");
                cancel.type = "button";
                cancel.className = "button button--ghost";
                cancel.textContent = "Cancel booking";
                cancel.addEventListener("click", () => cancelBooking(booking.id));
                card.appendChild(cancel);
            }
            list.appendChild(card);
        });
    }

    async function cancelBooking(bookingId) {
        const confirmed = window.confirm("Cancel this booking? The server will calculate any eligible refund using the event date.");
        if (!confirmed) return;
        setNotice(byId("bookings-message"), "Cancelling booking…");
        try {
            const booking = await apiRequest(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: "POST" });
            setNotice(byId("bookings-message"), `Booking cancelled. Refund amount: ${formatMoney(booking.refund)}.`, "success");
            await loadMyBookings({ quiet: true });
            setNotice(byId("bookings-message"), `Booking cancelled. Refund amount: ${formatMoney(booking.refund)}.`, "success");
            if (state.selectedConcert) await loadSeats(state.selectedConcert.id);
        } catch (error) {
            setNotice(byId("bookings-message"), error.message, "error");
        }
    }

    function closeSeatSelection() {
        if (state.hold) {
            setNotice(byId("payment-message"), "A temporary hold is active. Finish checkout or wait for it to expire before leaving this flow.", "error");
            byId("payment-panel").hidden = false;
            byId("payment-panel").scrollIntoView({ behavior: "smooth", block: "start" });
            return;
        }
        byId("seat-selection").hidden = true;
        byId("auth-panel").hidden = true;
        byId("concerts").scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function configureNavigation() {
        const toggle = byId("nav-toggle");
        const navigation = byId("primary-navigation");
        toggle.addEventListener("click", () => {
            const open = !navigation.classList.contains("is-open");
            navigation.classList.toggle("is-open", open);
            toggle.setAttribute("aria-expanded", String(open));
            toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
        });

        navigation.querySelectorAll("a").forEach((link) => {
            link.addEventListener("click", () => {
                navigation.classList.remove("is-open");
                toggle.setAttribute("aria-expanded", "false");
                toggle.setAttribute("aria-label", "Open navigation");
            });
        });

        byId("my-bookings-link").addEventListener("click", (event) => {
            event.preventDefault();
            void loadMyBookings({ scroll: true });
        });

        byId("logout-button").addEventListener("click", () => {
            if (state.hold) {
                setNotice(byId("payment-message"), "You have an active seat hold. Finish checkout or wait for it to expire before signing out.", "error");
                byId("payment-panel").hidden = false;
                byId("payment-panel").scrollIntoView({ behavior: "smooth", block: "start" });
                return;
            }
            clearSession();
            setNotice(byId("bookings-message"), "You have signed out.");
            byId("booking-list").replaceChildren();
        });
    }

    function configureEvents() {
        byId("continue-checkout-button").addEventListener("click", () => void beginCheckout());
        byId("suggest-seats-button").addEventListener("click", () => void suggestAdjacentSeats());
        byId("close-seat-selection").addEventListener("click", closeSeatSelection);
        byId("auth-form").addEventListener("submit", submitAuth);
        byId("payment-form").addEventListener("submit", submitPayment);
        document.querySelectorAll("[data-auth-mode]").forEach((button) => {
            button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
        });
        byId("refresh-bookings-button").addEventListener("click", () => void loadMyBookings({ scroll: false }));
        byId("view-bookings-button").addEventListener("click", () => void loadMyBookings({ scroll: true }));
    }

    function init() {
        updateAccountUI();
        configureNavigation();
        configureEvents();
        setAuthMode("login");
        void loadConcerts();
    }

    init();
})();
