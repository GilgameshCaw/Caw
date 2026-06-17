# CAW — Value Thesis

Why building this system is expected to perpetuate the value of CAW. This is an
*economic argument*, not a price prediction — it explains the value drivers the
protocol's design creates, and the belief that motivated building it. For the
formal specification see [`WHITEPAPER.md`](./WHITEPAPER.md); for the reasoning
behind design choices see [`DESIGN_RATIONALE.md`](./DESIGN_RATIONALE.md).

> **What this document is not.** Nothing here is financial advice or a price
> prediction. Token prices depend on countless factors no one can foresee, and
> this document makes no claim about what CAW will be worth or when. What it
> *does* claim is that the protocol is designed so that *using it* creates
> genuine, structural demand for the token — and explains why.

## Built because people believed in it

CAW did not begin as a startup chasing a market. It began, in the words of the
manifesto, as "nothing — no developer, no information, no medium of
communication. Simply, a contract." A community formed around it and gave it
meaning before there was any roadmap or company. The protocol described here is
the community's answer to a destiny the manifesto laid out years earlier: a
decentralized social clearing-house that no single person or entity can control
or benefit from disproportionately.

That origin matters to the value thesis. A token whose existence depends on a
company's continued goodwill carries that company's risk. CAW's design removes
the company entirely — renounced contracts, no treasury, no team allocation,
"the token's distribution at deploy is the distribution." What remains is a
public utility whose value, if it has any, accrues to its users and holders
rather than to a controlling party. That is the thing people believed in: not a
product to be sold, but a public good that, once built, belongs to no one and
therefore to everyone.

## The use case is real, and using it consumes CAW

Many tokens search for a use case after launch. CAW's use case *is* the token:
you cannot use the network without spending CAW. Every post, like, follow, and
tip is paid in CAW. Every username is minted by **burning** CAW, and shorter,
more desirable names burn exponentially more — a single-character name is, by
design, a six-to-eight-figure commitment depending on market cap.

This ties demand for the token to demand for the network. As more people use
CAW — post, build identities, claim names — more CAW is spent and burned. The
demand is not speculative; it is *functional*. You buy CAW because you want to
do something with it.

## Structural buy pressure and supply contraction

Two mechanisms turn network usage into pressure on the token:

1. **Burn-to-mint scarcity.** CAW burned to mint a username goes to `0xdead`
   permanently. This is a one-way contraction of supply that scales with
   adoption: the more identities minted, the more CAW permanently removed. The
   namespace is artificially scarce and that scarcity is paid for in burned
   tokens.

2. **Fees that buy and burn.** Network operators' ETH fee gates don't sit in a
   treasury. Through `CawBuyAndBurn`, collected ETH is swapped to CAW on the
   open market, and half of every fee is burned at `0xdead` (the other half pays
   the operator, in CAW — aligning their incentives with the token, not against
   it). So network activity translates into open-market *buying* of CAW and
   further *burning* of it.

Every CAW that flows through the system ends in one of four states: held,
redistributed to other holders, paid to validators, or burned. None of it
accrues to a protocol treasury, because there isn't one.

## Holding CAW is productive, not just speculative

A CAW holder isn't limited to waiting for price movement. Simply holding CAW on
L2 counts as staking — there's no lock-up or opt-in — and earns a share of the
depositor pool in proportion to balance. Crucially, that yield is funded by
network *usage* (a portion of posts, likes, recaws), not by inflating the
supply: it's a redistribution of what active users spend, not new tokens minted
out of thin air. So the yield is real but not free money — it exists to the
extent the network is used. This gives the token a use *for holders* (yield)
on top of its use *for actors* (spending), broadening the reasons to hold it.

## Why the design itself perpetuates value

Put the pieces together:

- **Usage requires spending CAW** → functional, non-speculative demand.
- **Minting burns CAW, more for scarce names** → supply contracts as identity
  adoption grows.
- **Fees buy-and-burn CAW** → network activity becomes market buying + burning.
- **No treasury, no team allocation, renounced contracts** → no overhang of
  insider supply, no party that can dilute or fee-extract.
- **Staking yield** → a reason to hold, sourced from real usage.

The thesis is simple: a protocol where *every use* spends or burns the token,
*every fee* buys-and-burns it, *no insider* can dilute it, and *holding* it is
productive, is a protocol whose value is structurally linked to its adoption.
The manifesto's destiny — a censorship-resistant public square owned by no one —
is also, not by accident, an economic engine that converts belief and usage into
durable demand for CAW.

## The honest caveat

None of this guarantees a price outcome. Adoption could be slow; markets are
irrational over any horizon that matters; competing systems exist. What the
design *does* guarantee is the **mechanism**: if people use CAW, the token is
spent, burned, and bought, with no party positioned to siphon that value away.
Whether people use it is up to the community that, from the beginning, has been
the only thing CAW ever depended on.
