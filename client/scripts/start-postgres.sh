#!/usr/bin/env bash
# Start PostgreSQL if it's not already running, then block so `concurrently`
# treats it as a long-running service (it doesn't like processes that exit 0).

set -uo pipefail

if pg_isready -q; then
  echo 'PostgreSQL is already running'
  exec tail -f /dev/null
fi

# Pick the data dir. Respect $PGDATA if set, otherwise detect homebrew layout.
if [[ -z "${PGDATA:-}" ]]; then
  if [[ -d /opt/homebrew/var/postgres ]]; then
    PGDATA=/opt/homebrew/var/postgres
  else
    PGDATA=/usr/local/var/postgres
  fi
fi
export PGDATA

pg_ctl -D "$PGDATA" start
exec tail -f /dev/null
