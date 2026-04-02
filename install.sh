#!/usr/bin/env bash
set -e

# Colors
GOLD='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo -e "${GOLD}  ██████╗ █████╗ ██╗    ██╗${RESET}"
echo -e "${GOLD}  ██╔═══╝██╔══██╗██║    ██║${RESET}"
echo -e "${GOLD}  ██║    ███████║██║ █╗ ██║${RESET}"
echo -e "${GOLD}  ██║    ██╔══██║██║███╗██║${RESET}"
echo -e "${GOLD}  ██████╗██║  ██║╚███╔███╔╝${RESET}"
echo -e "${GOLD}  ╚═════╝╚═╝  ╚═╝ ╚══╝╚══╝${RESET}"
echo ""
echo -e "${DIM}  CAW Protocol Node Installer${RESET}"
echo ""

# Check for required tools
check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo -e "  ${GOLD}$1${RESET} is not installed."
    return 1
  fi
  return 0
}

# Check Node.js
if ! check_command node; then
  echo "  Installing Node.js 22 via nvm..."
  if ! check_command nvm; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  fi
  nvm install 22
  nvm use 22
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "  ${GOLD}Warning:${RESET} Node.js 20+ required (found v$(node -v))"
  echo "  Consider: nvm install 22 && nvm use 22"
fi

# Check git
if ! check_command git; then
  echo "  Please install git first: https://git-scm.com/"
  exit 1
fi

# Determine install directory
INSTALL_DIR="${CAW_DIR:-$HOME/caw}"

echo -e "  ${DIM}Installing to: ${INSTALL_DIR}${RESET}"
echo ""

# Clone or update the repo
REPO_URL="${CAW_REPO:-https://github.com/user/CAW-nfts.git}"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo -e "  ${GREEN}Existing installation found. Updating...${RESET}"
  cd "$INSTALL_DIR"
  git pull --ff-only || echo "  Could not auto-update. Continuing with existing version."
else
  echo -e "  ${DIM}Cloning CAW repository...${RESET}"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install CLI dependencies
echo -e "  ${DIM}Installing CLI dependencies...${RESET}"
cd cli
npm install --silent 2>/dev/null
cd ..

# Run the interactive installer
echo ""
node cli/bin/caw.js install --dir "$INSTALL_DIR"
