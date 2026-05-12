# V2 cleanup registry

Pre-launch testnet is a single-path zone: we don't carry compatibility shims for old payloads, old wire formats, or migrated state. When something HAS to be carried temporarily (because dropping it would erase visible user data), we add it here so it's not forgotten at the v2 contract redeploy — that's the canonical "wipe and start clean" moment.

When the v2 contract deploy happens, every item in this file should be removed in a single commit. The branch model is described in `project_contract_ui_branch_split.md` (memory): solidity changes land on master; the FE/backend version that targets the new contracts ships from `contract-support-v2` and merges after deploy. This file should travel with `contract-support-v2` so the cleanup commits land alongside the rest of the new-contract code.

---

## Active shims (delete at v2)

### DM image legacy reader path

**Where:** `client/src/services/FrontEnd/src/components/EncryptedImage.tsx`, `client/src/services/FrontEnd/src/pages/Messages.tsx`

**What:** `EncryptedImage` accepts an optional `legacySharedSecret` prop alongside the new sealed-key envelope path (`sealedKey` + `senderTokenId` + `senderPublicKey`). When `sealedKey` is missing on a message attachment, the reader falls back to decrypting the binary directly against the conversation's shared secret.

**Why it exists:** the 2026-05-12 commit `350681b` introduced envelope encryption for DM attachments (random AES key per upload, sealed per recipient — same shape text DMs were already using) to fix group chat images. The new shape is unconditional on the upload path, but receivers viewing OLD attachments (uploaded before the rollout) only have the legacy `sharedSecret`-encrypted blob with no `sealedKeys` map. Without the fallback every existing DM image renders as "Attachment unavailable" — a visible regression on test.caw.social.

**Removal:**
- Drop the `legacySharedSecret?: CryptoKey | null` prop from `EncryptedImageProps`.
- Drop the `hasLegacyPath` branch in `EncryptedImage`'s `useEffect`.
- In `Messages.tsx`, restore the strict guard: if `mySlot` or `senderPub` is missing, render "Attachment unavailable" (no fallback).
- Group-chat legacy attachments are already unreadable in the fallback (the old per-pair shared secret only ever worked for one recipient), so removal causes no additional group-side regression — only 1:1 legacy attachments become unreadable.
