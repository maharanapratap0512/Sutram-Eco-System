# 🌐 SutramLan (`@sutram/lan`)
## Zero-Config P2P LAN Peer Discovery, Project Advertising & Secure Collaboration

`sutramLan` is a standalone, high-performance, zero-dependency Node.js package designed for local network (LAN) peer discovery, live database/project advertising, and credential-protected peer-to-peer collaboration in the Sutram ecosystem.

---

## 🌟 Key Features

1. **Zero External Dependencies**:
   - Built 100% on native Node.js core modules (`dgram`, `crypto`, `os`, `events`).
   - Zero native C++ compilation, zero fragile bindings. Runs identically on macOS, Windows, Linux, and inside Tauri sidecars.
2. **Automatic LAN Discovery (ZeroConf / UDP Beacon)**:
   - Uses UDP broadcast (`255.255.255.255:43210`) with fast heartbeats (default 3s).
   - No router configuration, no static IP, no port forwarding required.
   - Nodes automatically detect each other across Wi-Fi or wired office subnets.
3. **Selective "Go Live" Project Sharing**:
   - Multiple SQLite/database projects can reside on a single machine.
   - Each project has an independent sharing flag (`is_live`). Only explicitly shared projects are broadcast to the network.
4. **Replay-Proof Challenge-Response Security**:
   - PIN / Password protected project sharing.
   - Server issues a random cryptographic challenge (`crypto.randomBytes(16)`).
   - Client computes `HMAC-SHA256(pinHash, challenge)`.
   - Timing-safe verification (`crypto.timingSafeEqual`) prevents timing attacks.
   - Generates signed, tamper-proof session tokens (HMAC-SHA256 with 24h expiration).
5. **Fast Offline Detection**:
   - Automatic cleanup of stale peers (default 10s TTL window).
   - Graceful disconnect packet (`bye` action) removes nodes from peer tables instantly upon shutdown.
6. **Express Middleware Built-in**:
   - `lan.authMiddleware('projectId')` protects remote API endpoints with a single line of code.

---

## 🏗️ Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                          SutramLan                            │
│                                                               │
│   ┌────────────────────┐            ┌─────────────────────┐   │
│   │     LanBeacon      │            │     LanScanner      │   │
│   │ (UDP 43210 Tx)     │            │ (UDP 43210 Rx)      │   │
│   │ Broadcasts:        │            │ Discovers peers:    │   │
│   │ - Node Name / ID   │            │ - Maintains Map     │   │
│   │ - IP & Port        │            │ - Emits lifecycle   │   │
│   │ - Live Projects    │            │ - Prunes dead nodes │   │
│   └─────────┬──────────┘            └──────────┬──────────┘   │
│             │                                  │              │
│             └────────────────┬─────────────────┘              │
│                              │                                │
│                     ┌────────┴────────┐                       │
│                     │   LanSecurity   │                       │
│                     │ - PBKDF2 Hashes │                       │
│                     │ - Challenges    │                       │
│                     │ - Signed Tokens │                       │
│                     └─────────────────┘                       │
└───────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start Guide

### 1. Installation
Inside the Sutram ecosystem:
```javascript
const { SutramLan, LanSecurity } = require('../packages/sutramLan');
```

### 2. Initializing & Starting the Node
```javascript
const lan = new SutramLan({
  nodeName: 'Office-Workstation',
  httpPort: 3300,
  broadcastPort: 43210 // Default: 43210
});

// Start broadcasting and scanning
await lan.start();

// Listen to discovery events
lan.on('peer:found', (peer) => {
  console.log(`🟢 New Sutram peer discovered: ${peer.nodeName} (${peer.host}:${peer.port})`);
  console.log('Shared projects:', peer.projects);
});

lan.on('peer:updated', (peer) => {
  console.log(`🔄 Peer updated projects: ${peer.nodeName}`);
});

lan.on('peer:lost', ({ nodeId, peer, reason }) => {
  console.log(`🔴 Peer went offline: ${peer?.nodeName || nodeId} (${reason})`);
});
```

---

### 3. Sharing a Project with Security (PIN / Password)

```javascript
// Share a project protected by a 4-digit PIN
lan.shareProject({
  id: 'my_company_erp_2026',
  name: 'My Company ERP (2026)',
  tablesCount: 16,
  description: 'Main sales and ledger database',
  authType: 'pin',
  pin: '7890'
});

// Stop sharing (reverts back to local-only)
lan.unshareProject('my_company_erp_2026');
```

---

### 4. Remote Client Authentication Handshake

When a remote computer (e.g. Brother's PC) wants to connect:

```javascript
// Step 1: Server issues a random challenge
const { challenge, authType } = lan.createAuthChallenge('my_company_erp_2026');

// Step 2: Client computes solution using their entered PIN hash
const pinHash = LanSecurity.hashSecret('7890', salt).hash;
const clientSolution = LanSecurity.solveChallenge(pinHash, challenge);

// Step 3: Server verifies the solution and returns a signed token
const authResult = lan.verifyAuthResponse(challenge, clientSolution);

if (authResult.success) {
  console.log('Authenticated! Session Token:', authResult.token);
} else {
  console.error('Authentication failed:', authResult.error);
}
```

---

### 5. Protecting Express Endpoints with Middleware

```javascript
const express = require('express');
const app = express();

// Protect remote project routes with SutramLan authMiddleware
app.use('/api/:projectId/*', lan.authMiddleware('projectId'));

app.get('/api/:projectId/tables', (req, res) => {
  // Access permitted! req.lanSession contains verified token info
  res.json({ success: true, user: req.lanSession });
});
```

---

## 📖 API Reference

### `new SutramLan(options)`
- `nodeName` *(string)*: Human-readable machine name (default: `os.hostname()`).
- `httpPort` *(number)*: Port of the running Sutram HTTP API server (default: `3300`).
- `broadcastPort` *(number)*: UDP port for LAN discovery (default: `43210`).
- `broadcastIntervalMs` *(number)*: Heartbeat frequency in ms (default: `3000`).
- `peerTtlMs` *(number)*: Offline timeout window in ms (default: `10000`).
- `serverSecret` *(string)*: Optional 32-byte secret for session token HMACs.

### Methods
- `await lan.start()`: Initializes and binds beacon and scanner.
- `await lan.stop()`: Sends goodbye packet and shuts down sockets.
- `lan.shareProject(project)`: Shares a project with optional PIN or password.
- `lan.unshareProject(projectId)`: Stops sharing a project.
- `lan.getPeers()`: Returns an Array of all currently active discovered peers.
- `lan.getNodeInfo()`: Returns identity details of the current node.
- `lan.createAuthChallenge(projectId)`: Generates a replay-safe challenge for authentication.
- `lan.verifyAuthResponse(challenge, response)`: Validates solution and issues token.
- `lan.verifyToken(token)`: Verifies signed session token.
- `lan.authMiddleware(paramName)`: Express middleware for route authorization.

### Events
- `'peer:found' (peerData)`: Fired when a new node appears on the network.
- `'peer:updated' (peerData)`: Fired when an existing node updates its shared project catalog.
- `'peer:lost' ({ nodeId, peer, reason })`: Fired when a node disconnects or times out.
- `'error' (err)`: Fired on network or socket errors.
