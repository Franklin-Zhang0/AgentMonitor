#!/usr/bin/env bash
set -euo pipefail

# Deploy AgentMonitor Relay to public server
# Usage: ./relay/scripts/deploy.sh [token]
#
# Prerequisites:
#   - SSH access to newserver (see ~/.ssh/config)
#   - Node.js 18+ on the remote server
#   - pm2 installed globally on the remote server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REMOTE="newserver"
RELAY_TOKEN="${1:-${RELAY_TOKEN:-}}"
RELAY_PASSWORD="${2:-${RELAY_PASSWORD:-}}"

if [ -z "$RELAY_TOKEN" ]; then
  echo "Error: RELAY_TOKEN required. Pass as first argument or set env var."
  echo "Usage: $0 <token> [password]"
  exit 1
fi

if [ -z "$RELAY_PASSWORD" ]; then
  echo "WARNING: No RELAY_PASSWORD set — dashboard will be unprotected!"
  echo "  Pass as second argument or set RELAY_PASSWORD env var."
fi

# Get remote home directory
REMOTE_HOME=$(ssh "$REMOTE" 'echo $HOME')
APP_ROOT="$REMOTE_HOME/agentmonitor-relay"
RELAY_DIR="$APP_ROOT/relay"

echo "=== Building client ==="
cd "$PROJECT_ROOT"
npm run build:client

echo "=== Building relay ==="
cd "$PROJECT_ROOT/relay"
npx tsc

echo "=== Deploying to $REMOTE:$APP_ROOT ==="

# Create remote directories.
# Layout must match relay/src/index.ts:
#   <app-root>/relay/dist
#   <app-root>/client-dist
#   <app-root>/docs-dist
ssh "$REMOTE" "mkdir -p $APP_ROOT/client-dist $RELAY_DIR/dist"

# Sync relay build output
rsync -avz --delete "$PROJECT_ROOT/relay/dist/" "$REMOTE:$RELAY_DIR/dist/"
rsync -avz "$PROJECT_ROOT/relay/package.json" "$PROJECT_ROOT/relay/package-lock.json" "$REMOTE:$RELAY_DIR/"

# Sync client build
rsync -avz --delete "$PROJECT_ROOT/client/dist/" "$REMOTE:$APP_ROOT/client-dist/"

# Sync docs build if it exists
if [ -d "$PROJECT_ROOT/docs/.vitepress/dist" ]; then
  ssh "$REMOTE" "mkdir -p $APP_ROOT/docs-dist"
  rsync -avz --delete "$PROJECT_ROOT/docs/.vitepress/dist/" "$REMOTE:$APP_ROOT/docs-dist/"
fi

echo "=== Installing dependencies on remote ==="
ssh "$REMOTE" "cd $RELAY_DIR && npm ci --omit=dev 2>&1 | tail -3"

echo "=== Starting relay with pm2 ==="
ssh "$REMOTE" "export PATH=\$HOME/.npm-global/bin:\$PATH && cd $APP_ROOT && \
  pm2 delete agentmonitor-relay 2>/dev/null || true && \
  RELAY_TOKEN='$RELAY_TOKEN' RELAY_PASSWORD='$RELAY_PASSWORD' RELAY_PORT=3457 \
  pm2 start relay/dist/index.js --name agentmonitor-relay \
    --restart-delay=3000"

echo ""
echo "=== Deploy complete ==="
echo "Relay running at: http://192.3.168.14:3457"
echo "Tunnel endpoint:  ws://192.3.168.14:3457/tunnel"
echo ""
echo "To connect from local machine, set:"
echo "  RELAY_URL=ws://192.3.168.14:3457/tunnel"
echo "  RELAY_TOKEN=$RELAY_TOKEN"
if [ -n "$RELAY_PASSWORD" ]; then
  echo "Dashboard login password: (set via RELAY_PASSWORD)"
fi
