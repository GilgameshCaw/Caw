-- Atomic cawonce reservations. Used by POST /api/users/allocate-cawonce
-- to defend against the localStorage race that lets concurrent submissions
-- pick the same cawonce — see the Hashtag.displayName migration's sibling
-- commit for the full discussion. Reservations live ~5 minutes max, then
-- DataCleaner sweeps them.
CREATE TABLE "CawonceReservation" (
    "senderId"   INTEGER NOT NULL,
    "cawonce"    INTEGER NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "CawonceReservation_senderId_cawonce_key"
    ON "CawonceReservation" ("senderId", "cawonce");

CREATE INDEX "CawonceReservation_reservedAt_idx"
    ON "CawonceReservation" ("reservedAt");
