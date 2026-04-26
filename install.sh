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

# ---------- Host capability check --------------------------------------------
#
# A full node runs ES (512MB heap), Postgres, Redis, Node + pm2, and an nginx
# build of the React app. ~3.5GB of working set + headroom — we recommend 4GB
# RAM minimum, 8GB for comfortable margin. Two cores. 25GB disk for the OS,
# packages, repo, and DB growth.
#
# Below minimum, warn and prompt to continue. Above minimum, silently note
# the available headroom so anyone reading the install log knows what we saw.

# Each measurement is best-effort — different distros / containers expose
# this differently and we'd rather skip a metric than abort the installer
# over a missing /proc/meminfo entry. Empty string = "couldn't tell."
ram_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo "")
cores=$(nproc 2>/dev/null || echo "")
# `df -BG` is GNU coreutils; busybox `df` doesn't accept it. Try the GNU form
# first, fall back to plain df parsing.
disk_gb=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9' || true)
if [[ -z "$disk_gb" ]]; then
  # busybox df: 1K-blocks → divide by 1024^2 to GB.
  disk_gb=$(df -k / 2>/dev/null | awk 'NR==2 {printf "%d", $4/1024/1024}' || echo "")
fi

log "Detected: ${ram_gb:-?} GB RAM, ${cores:-?} cores, ${disk_gb:-?} GB free on /"

# Only warn on metrics we successfully measured. A missing reading shouldn't
# turn into a "below 4GB" false alarm.
low=()
[[ -n "$ram_gb"  && "$ram_gb"  -lt 4  ]] && low+=("RAM (${ram_gb} GB; recommended 4+)")
[[ -n "$cores"   && "$cores"   -lt 2  ]] && low+=("CPU cores (${cores}; recommended 2+)")
[[ -n "$disk_gb" && "$disk_gb" -lt 20 ]] && low+=("free disk (${disk_gb} GB; recommended 20+)")

if (( ${#low[@]} > 0 )); then
  warn "This host is below recommended specs:"
  for item in "${low[@]}"; do warn "  • $item"; done
  warn "Install will likely succeed but ES may OOM and the frontend build may swap."
  if [[ -t 0 ]] || [[ -r /dev/tty ]]; then
    if [[ -t 0 ]]; then
      read -r -p "  Continue anyway? [y/N]: " ans
    else
      read -r -p "  Continue anyway? [y/N]: " ans < /dev/tty
    fi
    [[ "${ans:-N}" =~ ^[Yy]$ ]] || { err "Aborting."; exit 1; }
  else
    warn "No tty — proceeding anyway (set SKIP_HOST_CHECK=1 to silence)."
  fi
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

# ---------- API port (auto-pick the next free one) ---------------------------
#
# Multiple CAW installs can coexist under different subdomains (e.g.
# test1.caw.social + test2.caw.social). They can't all bind :4000, so we
# scan existing ecosystem.config.cjs files in /var/www/*/ for already-
# assigned API ports and pick max + 1. The operator can override with
# CAW_API_PORT.
#
# We read OUR own ecosystem files rather than scanning listening ports
# because (a) it's deterministic across reboots and (b) it ignores ports
# held by non-CAW processes.

if [[ -z "${CAW_API_PORT:-}" ]]; then
  highest=3999
  for eco in /var/www/*/ecosystem.config.cjs; do
    [[ -f "$eco" ]] || continue
    # Skip the ecosystem file we're about to overwrite — its old port
    # shouldn't constrain our new one.
    [[ "$eco" == "$CAW_DIR/ecosystem.config.cjs" ]] && continue
    # Match: PORT: 4001  or  PORT: "4001"
    port=$(grep -oE '"?PORT"?\s*:\s*"?[0-9]+' "$eco" 2>/dev/null \
      | grep -oE '[0-9]+' | head -1)
    if [[ -n "$port" && "$port" -gt "$highest" ]]; then
      highest=$port
    fi
  done
  CAW_API_PORT=$((highest + 1))
fi
export CAW_API_PORT
log "API port:          ${CAW_API_PORT}"

# ---------- Infrastructure placement -----------------------------------------
#
# Decide BEFORE we apt-install anything how the operator wants to run the
# stateful services (Postgres, Redis, Elasticsearch). Three options:
#
#   native   — install via apt, run as systemd services (default)
#   docker   — pull docker images and run via docker compose
#   existing — connect to URLs the operator already has
#
# Power users can skip the prompt by setting CAW_INFRA_MODE in the env, and
# can short-circuit even further by passing CAW_DB_URL / CAW_REDIS_URL /
# CAW_ES_URL — those are forwarded to the Node CLI which writes them into the
# generated .env. Whatever isn't overridden gets installed/started normally.

ask_infra_mode() {
  local prompt='
  Where should Postgres, Redis, and Elasticsearch run?
    1) Native install (recommended)
    2) Docker (containers managed by docker compose)
    3) Connect to existing services I already have

  Choice [1]: '
  local answer
  if [[ -t 0 ]]; then
    read -r -p "$prompt" answer
  elif [[ -r /dev/tty ]]; then
    read -r -p "$prompt" answer < /dev/tty
  else
    answer=1
  fi
  case "${answer:-1}" in
    1|n|N|native|'') echo native ;;
    2|d|D|docker) echo docker ;;
    3|e|E|existing) echo existing ;;
    *) err "Invalid choice: $answer"; return 1 ;;
  esac
}

if [[ -z "${CAW_INFRA_MODE:-}" ]]; then
  CAW_INFRA_MODE="$(ask_infra_mode)"
fi

case "$CAW_INFRA_MODE" in
  native|docker|existing) ;;
  *) err "CAW_INFRA_MODE must be one of: native, docker, existing (got '$CAW_INFRA_MODE')"; exit 1 ;;
esac
export CAW_INFRA_MODE

log "Infra mode:        ${CAW_INFRA_MODE}"
[[ -n "${CAW_DB_URL:-}" ]]    && log "Postgres URL:      (override via CAW_DB_URL)"
[[ -n "${CAW_REDIS_URL:-}" ]] && log "Redis URL:         (override via CAW_REDIS_URL)"
[[ -n "${CAW_ES_URL:-}" ]]    && log "Elasticsearch URL: (override via CAW_ES_URL)"

# ---------- Step 1: System packages ------------------------------------------

if [[ "$SKIP_BOOTSTRAP" == "1" ]]; then
  step "Skipping system bootstrap (SKIP_BOOTSTRAP=1)"
else
  step "Installing system packages"
  log "(detailed output streams to ${INSTALL_LOG})"

  export DEBIAN_FRONTEND=noninteractive

  # Always-installed: things every node needs regardless of infra mode.
  ALWAYS_PKGS=(
    curl ca-certificates gnupg git build-essential
    nginx ufw certbot python3-certbot-nginx
  )

  # Stateful services — only install the ones the user wants natively, and
  # only the ones they didn't already override with their own URL. (E.g. if
  # they set CAW_DB_URL=postgres://external-host... we skip postgresql.)
  NATIVE_INFRA_PKGS=()
  if [[ "$CAW_INFRA_MODE" == "native" ]]; then
    [[ -z "${CAW_DB_URL:-}" ]]    && NATIVE_INFRA_PKGS+=(postgresql postgresql-contrib)
    [[ -z "${CAW_REDIS_URL:-}" ]] && NATIVE_INFRA_PKGS+=(redis-server)
    # Elasticsearch handled separately (different apt repo).
  fi

  quiet "Updating apt metadata" apt-get update -qq
  quiet "Installing base packages" apt-get install -y -qq \
    "${ALWAYS_PKGS[@]}" "${NATIVE_INFRA_PKGS[@]}"

  # Docker mode: install docker engine + compose plugin instead.
  if [[ "$CAW_INFRA_MODE" == "docker" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      quiet "Installing Docker" bash -c '
        install -m 0755 -d /etc/apt/keyrings &&
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg &&
        chmod a+r /etc/apt/keyrings/docker.gpg &&
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list &&
        apt-get update -qq &&
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      '
    fi
    ok "Docker $(docker --version | awk "{print \$3}" | tr -d ,)"
  fi

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

  # Elasticsearch — only install natively if the operator picked native infra
  # AND didn't override the URL.
  if [[ "$CAW_INFRA_MODE" == "native" && -z "${CAW_ES_URL:-}" ]]; then
    if ! dpkg -l elasticsearch >/dev/null 2>&1; then
      quiet "Adding Elastic apt repo" bash -c '
        install -m 0755 -d /usr/share/keyrings &&
        curl -fsSL https://artifacts.elastic.co/GPG-KEY-elasticsearch | gpg --dearmor -o /usr/share/keyrings/elastic.gpg &&
        echo "deb [signed-by=/usr/share/keyrings/elastic.gpg] https://artifacts.elastic.co/packages/8.x/apt stable main" > /etc/apt/sources.list.d/elastic-8.x.list &&
        apt-get update -qq
      '
      quiet "Installing Elasticsearch" apt-get install -y -qq elasticsearch
    fi
  fi

  ok "System packages installed"
fi

# ---------- Step 2: Configure Elasticsearch ----------------------------------
#
# Only configure ES when the operator picked native install AND didn't override
# the URL. Docker users get ES from a container; "existing" users have their
# own ES somewhere else.
if [[ "$CAW_INFRA_MODE" != "native" || -n "${CAW_ES_URL:-}" ]]; then
  log "Skipping Elasticsearch config (infra mode: ${CAW_INFRA_MODE})"
else

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

fi  # end native ES config

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
#
# Only run this when we installed PG natively. Docker / existing handle their
# own readiness — the Node CLI's prisma push will retry / surface errors.
if [[ "$CAW_INFRA_MODE" == "native" && -z "${CAW_DB_URL:-}" ]]; then
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
fi

# ---------- Step 7: Install CLI deps + hand off ------------------------------

step "Installing CLI dependencies"

sudo -u "$CAW_USER" -H bash -c "cd '$CAW_DIR/cli' && npm install --silent" \
  || sudo -u "$CAW_USER" -H bash -c "cd '$CAW_DIR/cli' && npm install"

ok "CLI ready"

# ---------- Step 8: TLS certificate (own-cert path) --------------------------
#
# Find or wait for the operator's TLS files. The Node CLI's nginx step will
# pick a TLS source (LE / wildcard / own-cert), but if we can pre-resolve
# files here, we set CAW_CERT_PATH / CAW_KEY_PATH and the CLI skips the
# prompt entirely.
#
# Three precedence rules:
#   1. CAW_CERT_PATH + CAW_KEY_PATH already set → trust them.
#   2. /etc/ssl/<domain>/{fullchain.pem,<domain>.key} exists → use directly.
#   3. /etc/ssl/<parent-domain>/ wildcard exists → symlink and use.
#   4. Else prompt: scp the files now, press Enter, re-check.

if [[ -n "${CAW_DOMAIN:-}" && "${CAW_TLS_MODE:-}" != "skip" ]]; then
  step "TLS certificate"

  domain_dir="/etc/ssl/${CAW_DOMAIN}"
  parent_domain="${CAW_DOMAIN#*.}"
  parent_dir="/etc/ssl/${parent_domain}"

  if [[ -z "${CAW_CERT_PATH:-}" || ! -f "${CAW_CERT_PATH}" ]]; then
    if [[ -f "${domain_dir}/fullchain.pem" ]]; then
      CAW_CERT_PATH="${domain_dir}/fullchain.pem"
    elif [[ "$parent_domain" != "$CAW_DOMAIN" && -f "${parent_dir}/fullchain.pem" ]]; then
      CAW_CERT_PATH="${parent_dir}/fullchain.pem"
      log "Using wildcard cert from ${parent_dir}/"
    fi
  fi
  if [[ -z "${CAW_KEY_PATH:-}" || ! -f "${CAW_KEY_PATH}" ]]; then
    for candidate in \
      "${domain_dir}/${CAW_DOMAIN}.key" \
      "${domain_dir}/privkey.pem" \
      "${parent_dir}/${parent_domain}.key" \
      "${parent_dir}/privkey.pem"; do
      [[ -f "$candidate" ]] && { CAW_KEY_PATH="$candidate"; break; }
    done
  fi

  # Still missing? Wait for the user to scp the files in.
  if [[ -z "${CAW_CERT_PATH:-}" || -z "${CAW_KEY_PATH:-}" || ! -f "${CAW_CERT_PATH}" || ! -f "${CAW_KEY_PATH}" ]]; then
    mkdir -p "$domain_dir"
    chmod 700 "$domain_dir"
    echo
    log "No TLS files found for ${CAW_DOMAIN}."
    log "From your local machine, copy your cert + key onto this server:"
    echo
    echo -e "  ${GOLD}scp fullchain.pem your-key.key root@$(hostname -I | awk '{print $1}'):${domain_dir}/${RESET}"
    echo
    log "Or use ${parent_dir}/ if you have a wildcard for *.${parent_domain}."
    log "(If you'd rather the CLI handle TLS — Let's Encrypt or skip — just press Enter; the CLI will ask.)"
    echo
    if [[ -t 0 ]]; then
      read -r -p "  Press Enter when ready (or skip): " _
    elif [[ -r /dev/tty ]]; then
      read -r -p "  Press Enter when ready (or skip): " _ < /dev/tty
    fi
    # Re-check after the wait
    [[ -f "${domain_dir}/fullchain.pem" ]] && CAW_CERT_PATH="${domain_dir}/fullchain.pem"
    for candidate in "${domain_dir}/${CAW_DOMAIN}.key" "${domain_dir}/privkey.pem"; do
      [[ -f "$candidate" ]] && { CAW_KEY_PATH="$candidate"; break; }
    done
  fi

  if [[ -n "${CAW_CERT_PATH:-}" && -f "${CAW_CERT_PATH}" ]]; then
    chmod 644 "${CAW_CERT_PATH}" 2>/dev/null || true
    [[ -n "${CAW_KEY_PATH:-}" && -f "${CAW_KEY_PATH}" ]] && chmod 600 "${CAW_KEY_PATH}" 2>/dev/null || true
    ok "Cert: ${CAW_CERT_PATH}"
    ok "Key:  ${CAW_KEY_PATH}"
    export CAW_CERT_PATH CAW_KEY_PATH
  else
    log "(No cert resolved — the CLI will offer Let's Encrypt or own-cert prompts.)"
  fi
fi

# ---------- Step 9: Run the interactive installer ----------------------------

# The Node CLI from here on. It collects RPC URLs, validator config, infra
# choices, etc., writes the env files + pm2 ecosystem, runs prisma migrations,
# and starts the services.

echo
echo -e "${GOLD}▸${RESET} Handing off to the interactive installer..."
echo

cd "$CAW_DIR"
# Forward env into the sudo'd Node process. sudo strips env by default, so
# we pass each var explicitly. CAW_DOMAIN is consumed by infrastructure.js as
# the default for the domain prompt. CAW_INFRA_MODE / CAW_*_URL drive the infra
# branching. CAW_CERT_PATH / CAW_KEY_PATH let the nginx step skip its prompt.
exec sudo -u "$CAW_USER" -H \
  CAW_DOMAIN="${CAW_DOMAIN:-}" \
  CAW_INFRA_MODE="${CAW_INFRA_MODE:-native}" \
  CAW_DB_URL="${CAW_DB_URL:-}" \
  CAW_REDIS_URL="${CAW_REDIS_URL:-}" \
  CAW_ES_URL="${CAW_ES_URL:-}" \
  CAW_CERT_PATH="${CAW_CERT_PATH:-}" \
  CAW_KEY_PATH="${CAW_KEY_PATH:-}" \
  CAW_API_PORT="${CAW_API_PORT:-}" \
  node "$CAW_DIR/cli/bin/caw.js" install --dir "$CAW_DIR"
