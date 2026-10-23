// Create a row that a concurrent request may be creating at the same time.
//
// The DM relay route builds the rows a first message needs (placeholder User
// and DmIdentity, the dm:A:B Conversation) with a check-then-create. Two
// relays that need the same rows at once (the same message from more than
// one registry entry, two messages in a row to a new contact, or A and B
// writing to each other at the same moment) both pass the check, and the
// second insert fails on the unique index. That error used to end the
// request with a 500, and the sender doesn't retry, so the message was lost
// on this node.
//
// On a unique-constraint error (Prisma P2002) this reads the row back: if
// the other request created it, that row is returned and the caller carries
// on. Any other error, or a P2002 whose row still isn't there (a different
// unique column, e.g. a taken username), is thrown as before.

export async function createOrFindOnRace<T>(
  create: () => Promise<T>,
  find: () => Promise<T | null>,
): Promise<T> {
  try {
    return await create()
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err
    const row = await find()
    if (row == null) throw err
    return row
  }
}
