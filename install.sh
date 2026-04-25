#!/usr/bin/env bash
# CAW Protocol installer.
#
# This script bootstraps a brand-new Debian/Ubuntu host into a working CAW node.
# It installs every system dep (Node, Postgres, Redis, Elasticsearch, nginx,
# pm2, certbot), creates a non-root `caw` user, clones the repo, and hands off
# to the interactive Node CLI for configuration + service start.
#
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/GilgameshCaw/Caw/master/install.sh)"
#
# Or local:
#   sudo bash install.sh
#
# Environment overrides:
#   CAW_DIR       — install directory (default: /var/www/caw)
#   CAW_REPO      — git remote (default: https://github.com/GilgameshCaw/Caw.git)
#   CAW_USER      — system user that will own the install (default: caw)
#   CAW_BRANCH    — branch to check out (default: master)
#   SKIP_BOOTSTRAP=1 — skip apt installs (assume system deps already there)

set -euo pipefail

# ---------- Colors -----------------------------------------------------------
# ANSI-C quoting ($'...') so the escape bytes are real, not the literal string
# "\033[1;33m". This lets us use the vars inside `cat` heredocs without needing
# echo -e / printf for every line.

GOLD=$'\033[1;33m'
GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
DIM=$'\033[2m'
RESET=$'\033[0m'

log()  { echo -e "  $*"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $*"; }
warn() { echo -e "  ${GOLD}!${RESET} $*"; }
err()  { echo -e "  ${RED}✗${RESET} $*" >&2; }
step() { echo; echo -e "${GOLD}▸${RESET} $*"; }

# Run a command quietly. Stdout goes to /tmp/caw-install.log (so apt's
# unpacking spam doesn't drown the user); stderr stays attached so real errors
# surface in real time. On failure, dump the last 30 lines of the log so the
# operator has something to debug with. Usage: quiet <label> <cmd...>
INSTALL_LOG=/tmp/caw-install.log
: > "$INSTALL_LOG"
quiet() {
  local label="$1"; shift
  printf "  %s..." "$label"
  if "$@" >> "$INSTALL_LOG" 2>&1; then
    printf "\r  ${GREEN}✓${RESET} %s\n" "$label"
  else
    local rc=$?
    printf "\r  ${RED}✗${RESET} %s\n" "$label"
    echo
    err "Last 30 lines of $INSTALL_LOG:"
    tail -n 30 "$INSTALL_LOG" >&2
    return $rc
  fi
}

# ---------- Banner -----------------------------------------------------------

cat <<EOF

${GOLD}  ██████╗ █████╗ ██╗    ██╗${RESET}
${GOLD}  ██╔═══╝██╔══██╗██║    ██║${RESET}
${GOLD}  ██║    ███████║██║ █╗ ██║${RESET}
${GOLD}  ██║    ██╔══██║██║███╗██║${RESET}
${GOLD}  ██████╗██║  ██║╚███╔███╔╝${RESET}
${GOLD}  ╚═════╝╚═╝  ╚═╝ ╚══╝╚══╝${RESET}

${DIM}  CAW Protocol Node Installer${RESET}

EOF

# ---------- Sanity checks ----------------------------------------------------

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer supports Linux only (detected $(uname -s))."
  err "For local dev on macOS, see the README — install Node, Postgres, Redis,"
  err "and Elasticsearch via Homebrew, then run 'node cli/bin/caw.js install'."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  err "This installer requires apt-get (Debian/Ubuntu)."
  err "On other distros, install Node, Postgres, Redis, Elasticsearch, nginx,"
  err "yarn, and pm2 manually, then run 'node cli/bin/caw.js install'."
  exit 1
fi

# Re-exec with sudo if we're not root. The bootstrap installs system packages,
# creates users, configures services — none of that works without root.
if [[ $EUID -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    err "Not running as root and sudo is not available."
    exit 1
  fi
  log "Re-running with sudo (you may be prompted for your password)..."
  exec sudo -E bash "$0" "$@"
fi

# ---------- Defaults ---------------------------------------------------------

CAW_REPO="${CAW_REPO:-https://github.com/GilgameshCaw/Caw.git}"
CAW_USER="${CAW_USER:-caw}"
CAW_BRANCH="${CAW_BRANCH:-master}"
SKIP_BOOTSTRAP="${SKIP_BOOTSTRAP:-0}"

# Ask up front for the domain — it determines the install directory and
# pre-fills the domain question the Node CLI asks later. Skip if CAW_DIR
# was already provided via env (power-user override).
#
# When piped through curl, stdin is the script body, so prompts must read
# from the controlling tty directly.
if [[ -z "${CAW_DIR:-}" ]]; then
  echo
  echo -e "  ${DIM}This installer creates one node per directory. Pick a directory${RESET}"
  echo -e "  ${DIM}name based on the domain you'll serve from this node.${RESET}"
  echo
  echo -e "  ${DIM}Examples: testnet.caw.social, mynode.example.com${RESET}"
  echo -e "  ${DIM}If you don't have a domain yet, leave blank for /var/www/caw.${RESET}"
  echo
  if [[ -t 0 ]]; then
    read -r -p "  Domain (or blank): " CAW_DOMAIN
  elif [[ -r /dev/tty ]]; then
    read -r -p "  Domain (or blank): " CAW_DOMAIN < /dev/tty
  else
    warn "No tty available — defaulting domain to none."
    CAW_DOMAIN=""
  fi
  if [[ -n "$CAW_DOMAIN" ]]; then
    # Basic sanity check: at least one dot, no slashes/spaces.
    if [[ ! "$CAW_DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then
      err "That doesn't look like a valid domain: $CAW_DOMAIN"
      exit 1
    fi
    CAW_DIR="/var/www/$CAW_DOMAIN"
    export CAW_DOMAIN
  else
    CAW_DIR="/var/www/caw"
  fi
fi

log "Install directory: ${CAW_DIR}"
log "Repository:        ${CAW_REPO}#${CAW_BRANCH}"
log "Service user:      ${CAW_USER}"
[[ -n "${CAW_DOMAIN:-}" ]] && log "Domain:            ${CAW_DOMAIN}"

# ---------- Step 1: System packages ------------------------------------------

if [[ "$SKIP_BOOTSTRAP" == "1" ]]; then
  step "Skipping system bootstrap (SKIP_BOOTSTRAP=1)"
else
  step "Installing system packages"
  log "(detailed output streams to ${INSTALL_LOG})"

  export DEBIAN_FRONTEND=noninteractive
  quiet "Updating apt metadata" apt-get update -qq
  quiet "Installing base packages" apt-get install -y -qq \
    curl ca-certificates gnupg git build-essential \
    nginx ufw certbot python3-certbot-nginx \
    postgresql postgresql-contrib redis-server

  # Node 22 from NodeSource — the version the app's tested on. Distro Node is
  # typically too old (and we don't want to surprise the operator with whatever
  # version Ubuntu ships).
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
    quiet "Adding NodeSource repo" bash -c "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -"
    quiet "Installing Node.js 22" apt-get install -y -qq nodejs
  fi
  ok "Node $(node -v)"

  # Yarn + pm2 are runtime tools, not OS packages. npm-global is the right home.
  for tool in yarn pm2; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      quiet "Installing $tool" npm install -g --silent "$tool"
    fi
  done

  # Elasticsearch is in the Elastic apt repo, not Ubuntu's. Add it once.
  if ! dpkg -l elasticsearch >/dev/null 2>&1; then
    quiet "Adding Elastic apt repo" bash -c '
      install -m 0755 -d /usr/share/keyrings &&
      curl -fsSL https://artifacts.elastic.co/GPG-KEY-elasticsearch | gpg --dearmor -o /usr/share/keyrings/elastic.gpg &&
      echo "deb [signed-by=/usr/share/keyrings/elastic.gpg] https://artifacts.elastic.co/packages/8.x/apt stable main" > /etc/apt/sources.list.d/elastic-8.x.list &&
      apt-get update -qq
    '
    quiet "Installing Elasticsearch" apt-get install -y -qq elasticsearch
  fi

  ok "System packages installed"
fi

# ---------- Step 2: Configure Elasticsearch ----------------------------------

step "Configuring Elasticsearch (localhost-only, no auth, 512MB heap)"

# Cap heap so a 6GB VPS isn't suffocated. ES defaults to 1-8GB depending on
# host RAM and we're sharing the box with Postgres + Redis + Node.
mkdir -p /etc/elasticsearch/jvm.options.d
cat > /etc/elasticsearch/jvm.options.d/heap.options <<'EOF'
-Xms512m
-Xmx512m
EOF

# We disable xpack security entirely. ES listens on 127.0.0.1 only, ufw blocks
# 9200 from outside, and it's read by trusted local processes — adding TLS
# inside localhost is busywork that breaks more than it secures.
#
# Rather than try to sed-edit the elasticsearch-deb auto-config (which has bit
# us with multi-line nested mappings before), we back up the original once and
# replace it with a known-good minimal config. Re-runs are no-ops because the
# config we write is byte-identical.
ES_YML=/etc/elasticsearch/elasticsearch.yml
if [[ -f "$ES_YML" && ! -f "${ES_YML}.orig" ]]; then
  cp "$ES_YML" "${ES_YML}.orig"
fi
cat > "$ES_YML" <<'EOF'
# Managed by caw install.sh. The original elasticsearch-deb config is preserved
# at /etc/elasticsearch/elasticsearch.yml.orig.

# Single-node cluster — ES otherwise tries to bootstrap a multi-node cluster
# and refuses to start without a discovery configuration.
discovery.type: single-node

# Bind localhost only. Combined with ufw blocking 9200 from outside, this is
# why we can safely disable auth below.
network.host: 127.0.0.1
http.port: 9200

# Default paths from the deb package — keep them so logs/data land where ops
# tooling expects.
path.data: /var/lib/elasticsearch
path.logs: /var/log/elasticsearch

# Disable xpack security. CAW reads from 127.0.0.1 only.
xpack.security.enabled: false
xpack.security.enrollment.enabled: false
xpack.security.http.ssl.enabled: false
xpack.security.transport.ssl.enabled: false
EOF

systemctl daemon-reload
systemctl enable elasticsearch >/dev/null 2>&1
quiet "Starting Elasticsearch" systemctl restart elasticsearch
ok "Elasticsearch configured"

# ---------- Step 3: Firewall -------------------------------------------------

step "Configuring firewall"

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "ufw allows 22, 80, 443"

# ---------- Step 4: Service user ---------------------------------------------

step "Creating service user '${CAW_USER}'"

if ! id -u "$CAW_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$CAW_USER"
  ok "User created"
else
  ok "User already exists"
fi

# ---------- Step 5: Clone the repo -------------------------------------------

step "Fetching repository"

# Create only the install dir itself and chown that. We deliberately don't
# touch the parent (e.g. /var/www) — other deployments may live alongside.
mkdir -p "$CAW_DIR"
chown "$CAW_USER":"$CAW_USER" "$CAW_DIR"

if [[ -d "$CAW_DIR/.git" ]]; then
  log "Existing checkout — pulling latest..."
  sudo -u "$CAW_USER" -H git -C "$CAW_DIR" fetch origin "$CAW_BRANCH"
  sudo -u "$CAW_USER" -H git -C "$CAW_DIR" reset --hard "origin/$CAW_BRANCH"
elif [[ -n "$(ls -A "$CAW_DIR" 2>/dev/null)" ]]; then
  err "Install dir $CAW_DIR exists and is non-empty but not a git checkout."
  err "Move or remove it, or set CAW_DIR to a different path."
  exit 1
else
  # git clone refuses to clone into an existing directory unless it's empty,
  # which is exactly what we have. Use the directory directly.
  sudo -u "$CAW_USER" -H git clone --depth 1 -b "$CAW_BRANCH" "$CAW_REPO" "$CAW_DIR"
fi

ok "Repo at ${CAW_DIR}"

# ---------- Step 6: Wait for Postgres ----------------------------------------

# postgresql.service exits 0 immediately as a meta-target; the cluster is in
# postgresql@16-main. Don't proceed until pg_isready agrees the server is up.
step "Waiting for PostgreSQL"
for i in {1..30}; do
  if sudo -u postgres pg_isready -q; then
    ok "PostgreSQL ready"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    err "PostgreSQL didn't come up — check 'systemctl status postgresql@*'"
    exit 1
  fi
done

# ---------- Step 7: Install CLI deps + hand off ------------------------------

step "Installing CLI dependencies"

sudo -u "$CAW_USER" -H bash -c "cd '$CAW_DIR/cli' && npm install --silent" \
  || sudo -u "$CAW_USER" -H bash -c "cd '$CAW_DIR/cli' && npm install"

ok "CLI ready"

# ---------- Step 8: Run the interactive installer ----------------------------

# The Node CLI from here on. It collects RPC URLs, validator config, infra
# choices, etc., writes the env files + pm2 ecosystem, runs prisma migrations,
# and starts the services.

echo
echo -e "${GOLD}▸${RESET} Handing off to the interactive installer..."
echo

cd "$CAW_DIR"
# CAW_DOMAIN is consumed by infrastructure.js as the default for the domain
# prompt. sudo strips most env by default, so pass it explicitly.
exec sudo -u "$CAW_USER" -H \
  CAW_DOMAIN="${CAW_DOMAIN:-}" \
  node "$CAW_DIR/cli/bin/caw.js" install --dir "$CAW_DIR"
