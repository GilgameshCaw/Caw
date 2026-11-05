# DM permanence and deletion: decision record

This is a source-observed retention question within DM-03, not a new unauthorized-deletion exploit or an accusation of developer intent.

## Requirement and observed behavior

The [manifesto, requirement viii](https://github.com/cawdevelopment/manifesto/blob/37399aeb55974d4b09d404014865b5ef8918e9de/README.md) says “All data will be stored permanently” and requires trustless, permanent storage. It separately permits frontends to choose what to display. Requirement vii calls for secure peer-to-peer DMs and discourages group-chat complexity; discouragement is not an explicit ban on groups.

At `97cd13f3a1423f702d411472fdd2b2a2e7bfbd59`, [`client/src/api/routes/dm.ts`](https://github.com/GilgameshCaw/Caw/blob/97cd13f3a1423f702d411472fdd2b2a2e7bfbd59/client/src/api/routes/dm.ts) contains three distinct paths:

| Path | Source-observed behavior |
|---|---|
| POST /messages/:messageId/hide | Upserts a per-user MessageDeletion record. This is hiding; it does not itself null the message payload. |
| DELETE /messages/:messageId | Requires sender ownership and a five-minute window, then sets encryptedPayload and editHistory to null and contentType to deleted in the local Message row. |
| PATCH /messages/:messageId, group branch | Within the edit window, replaces per-recipient ciphertext rows in a database transaction; the source comment says this branch does not keep per-recipient edit history. |

Source SHA-256: `1368fec555677443b51ccffe59a6d7b08d270e1d17418bad4f40f8c7e79f5807`. Reproduce the trace with `git show 97cd13f3a1423f702d411472fdd2b2a2e7bfbd59:client/src/api/routes/dm.ts`, locate the three route declarations and follow their database writes. No database, API request, relay, independent archive or deployed system was executed in this review. No claim is made that every remote copy is erased, that no other archive exists, or that these routes are unauthorized.

## Existing work and non-duplication

[PR #215](https://github.com/GilgameshCaw/Caw/pull/215), head `6fe053260213145d693b496d924725636d65539b`, addresses residual group ciphertext being served after a delete-for-everyone operation. Its reported DB-backed tests were not rerun here. Do not preserve that exposure as a workaround for permanence, and do not duplicate the patch. Its privacy correction does not by itself resolve the separate protocol retention requirement. [#218](https://github.com/GilgameshCaw/Caw/pull/218) and [#350](https://github.com/GilgameshCaw/Caw/pull/350) cover related owner-key/relay boundaries, not a complete permanent recovery proof.

## Unresolved specification and evidence

If these DMs are within the permanent protocol-data promise, destructive local updates need an independently recoverable immutable record or a clearly agreed exception. If they are an optional service outside that promise, document that boundary and its consequences for account/NFT transfer, retention and recovery. A local tombstone is not proof of global erasure; a surviving stale ciphertext is not a permanent-storage design.

The [reproduced R2 text](https://github.com/Xubu-Trad/caw-lab/blob/canon/layers/R2-020_hex_transposition/MESSAGE.md) allows clear agreed changes. Its recovery does not authenticate the author. Please identify the agreed DM retention rule, which bytes/versions are protocol records, where independent recovery comes from, and what a sender's deletion actually promises. Then test the selected rule across operator loss, edits, deletion, ownership transfer and independent readers. Do not introduce central key escrow or a privileged recovery administrator as a silent solution.

This evidence sharpens an existing specification/architecture gap. It does not establish a universal manifesto violation from a database write alone; no contract or privacy policy is changed by this document.
