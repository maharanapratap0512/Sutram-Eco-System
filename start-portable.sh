#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Sutram 2.0: Portable One-Click Zero-Install Launcher (macOS/Linux)
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "======================================================="
echo "   🚀 SUTRAM DYNAMIC ERP 2.0 — PORTABLE EDITION"
echo "======================================================="
echo "📁 Portable Root: $SCRIPT_DIR"

# 1. Determine Node binary (Embedded runtime vs System Node)
NODE_BIN="node"
if [ -f "$SCRIPT_DIR/runtime/node" ]; then
  NODE_BIN="$SCRIPT_DIR/runtime/node"
  echo "✓ Using embedded runtime: $NODE_BIN"
else
  echo "✓ Using system runtime: $(which node 2>/dev/null || echo 'not found')"
fi

# 2. Check if Node is available
if ! command -v "$NODE_BIN" &> /dev/null; then
  echo "❌ Error: Node.js is required to start Sutram server."
  echo "Please install Node.js or place portable node in ./runtime/node"
  exit 1
fi

# 3. Start Sutram Server in background
echo "⚡ Starting Sutram Server (Port 3300) with LAN Discovery..."
cd "$SCRIPT_DIR/sutramServer"
"$NODE_BIN" server.js &
SERVER_PID=$!

trap "echo 'Shutting down Sutram...'; kill $SERVER_PID 2>/dev/null; exit 0" SIGINT SIGTERM EXIT

# 4. Give server a moment to start
sleep 2

# 5. Open in browser or native window
URL="http://localhost:3300"

echo "🌐 Opening Sutram ERP at: $URL"
if command -v open &> /dev/null; then
  open "$URL"
elif command -v xdg-open &> /dev/null; then
  xdg-open "$URL"
fi

wait $SERVER_PID
