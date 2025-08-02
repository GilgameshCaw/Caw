# caw client


### To start

# install dependencies
npm install

# reset & push Prisma schema
npm run prisma:reset

# run everything in dev
npm run dev


## 🗄️ Database & Cache Setup

You need PostgreSQL **and** Redis. Pick **one** of the following recipes (and will likely want to change your password):

---

### Option 1: Docker (recommended for quick start)

```bash
# Launch Postgres
docker run --rm -d \
  --name caw-postgres \
  -e POSTGRES_USER=caw \
  -e POSTGRES_PASSWORD=caw \
  -e POSTGRES_DB=caw \
  -p 5432:5432 \
  postgres:15-alpine

# Launch Redis
docker run --rm -d \
  --name caw-redis \
  -p 6379:6379 \
  redis:7-alpine

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"


### Option 2: Native install.

# Option 2A (macOS):

# Install
brew install postgresql redis

# Start services
brew services start postgresql
brew services start redis

# Create DB & user
psql postgres -c "CREATE ROLE caw WITH LOGIN PASSWORD 'caw';"
psql postgres -c "CREATE DATABASE caw OWNER caw;"

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"


# Option 2B (ubuntu):

# Install
sudo apt update
sudo apt install -y postgresql redis-server

# Create DB & user as the postgres superuser
sudo -iu postgres psql -c "CREATE ROLE caw WITH LOGIN PASSWORD 'caw';"
sudo -iu postgres psql -c "CREATE DATABASE caw OWNER caw;"

# Ensure Redis is running
sudo systemctl enable --now redis-server

# Set your DATABASE_URL
export DATABASE_URL="postgresql://caw:caw@127.0.0.1:5432/caw"





## Structure

this repo is organized into services which should be capable of running across
different machines.

**However**, all services can be run together in the same process. This makes
development and testing much easier, and even in production you might decide to
simply run some/all services together. Configure the list of services
you want to include:

```jsonc
// config.json
[
  {
    "service": "hello",
    "config": {}
  },
  {
    "service": "hello",
    // use instanceName if you want multiple instances of the same service
    // (defaults to the same name as the service, but instanceName must be
    // unique)
    "instanceName": "hello-copy",
    "config": {}
  },
  {
    "service": "other-service",
    "config": {
      // config specific to other-service goes here
    }
  },
]
```

To make this work, all comms between services must go over a socket/etc. Do not
pass native objects directly or rely on globals. This will prevent services from
running independently. Don't even think about it.

## Manual Testing Guide

```sh
npm install
cp config.template.json config.json
npm start
# to stop, use Ctrl+C
```

The template config used above just uses the `Hello` service, which can be used
to check all the stuff local to this repo is working properly.

Beyond that, the one and only meaningful service so far is `RawEventsGatherer`,
which gets events from ethereum rpc and inserts them into a postgres database.

To get this working:

**Step 1**: Postgres

You'll need postgres. If you're on macOS I recommend
[postgresapp](https://postgresapp.com/). Other options include docker, aws, and
running a good-old-fashioned native postgres instance.

**Step 2**: Ethereum Network

You'll need access to an ethereum network with a contract like this deployed:

```solidity
contract Emitter {
    uint256 id;
    event ActionsProcessed(uint256 indexed id, bytes data);

    constructor() {
        id = 0;
    }

    function process(bytes calldata data) public {
        emit ActionsProcessed(id, data);
        id++;
    }
}
```

Then call that process function (or otherwise) to emit the event.

You will need:
- A websocket rpc url for the network (starts with `ws://` or `wss://`)
- The deployed contract address

[Hardhat](https://hardhat.org/) is a viable option here (rpc at
`ws://127.0.0.1:8545`).

**Step 3**: Configure

Add `RawEventsGatherer` to your `config.json`:

```jsonc
[
  // ...
  {
    "service": "RawEventsGatherer",
    "config": {
      "rpcUrl": "see ethereum step",
      "contractAddress": "see ethereum step",
      "postgresDb": { /* see postgres step */ }
    }
  }
  // ...
]
```

**Step 4**: Trigger events and check

Call `.process` (or otherwise) on your contract a few times.

Check that rows are inserted into the database.
[TablePlus](https://tableplus.com/) can be useful here.






Notes:
  if a new provider gets events (more efficiently) from a untrusted source, 
  if the contract stored a 'current hash', which represented the entire history
  of all valid events, then the provider can reconstruct and verify all events
  against that.




