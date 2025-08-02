### CAW Protocol

CAW is a trustless and decentralized social clearing-house committed to making freedom of speech unstoppable

For more info, please see https://caw.is

# Current status:
Significant progress has been made on multiple fronts.
Just a few more features left, before cleaning up and polishing the front end.
We will soon be approaching the testing phase, and shortly after, we plan to deploy to mainnet.


# This repository contains the following:
- Solidity files that will be deployed to the mainnet and at least one L2
- Services to run as a node:
	- RawEventsGatherer: reads CAW action events from blockchain
    - ActionProcessor: builds indexed database based on Raw Events
	- Validator: can be run by anyone to process new Caw actions on chain
	- API: can receive new CAW actions and return the content of the database
	- FrontEnd: shows all posts, users, and actions, and allow users to take actions.
