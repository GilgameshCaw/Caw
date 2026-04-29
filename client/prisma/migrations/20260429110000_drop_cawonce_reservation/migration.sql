-- Drop the CawonceReservation system. The chain-only frontend allocation
-- + TxQueue partial unique index (added in 20260429100000) replace it
-- end-to-end. Reservations were a per-server view of "in use" cawonces,
-- which broke the moment the same user posted from a different install —
-- the chain has the only authoritative view.
DROP TABLE IF EXISTS "CawonceReservation";
