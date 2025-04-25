# CawUsernames

This is a solidity repository focused on building a fully decentralized social network 
as described by the CAW Manifesto, found at https://caw.is


# Deployment:

## deploy mintable Caw (if not mainnnet)
npx truffle deploy --network devL1

## deploy CawNamesL2
npx truffle deploy --network devL2

## deploy 
npx truffle deploy --network devL1

# Goerli Testnet

The current contracts have been deployed on the Goerli testnet.
You can view <a href='./docs/TESTNET_MINTING.md'>here</a>, along with instructions on how to mint a testnet username



# Approach To the Protocol

Read the <a href='./docs/APPROACH_AND_REASONING.md'>APPROACH AND REASONING document</a>
to understand the intended approach taken by this repository to furfil the protocol and specs
found in the <a href='https://caw.is'>CAW Manifesto</a>


# Stake Pool Rewards

As mentioned in the spec, many actions taken by a user will involve redistributing some funds,
as rewards, to "all other stakers". To accomplish this, an O(1) algorithm has been developed to
fulfil this redistribution continuously and efficiently.  You can read the logic and
<a href='./docs/STAKE_POOL_REWARDS.md'>proof of the algorithm here</a>.

# Contact and questions
Message me on telegram: https://t.me/Gilgamesh_Caw
Or my twitter: https://x.com/caw_dev
