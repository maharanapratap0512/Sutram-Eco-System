# 📐 SutramLan: Architecture & Network Protocol Specification

## 1. Overview
`sutramLan` establishes a decentralized, zero-configuration local mesh network for Sutram instances running on a shared local area network (LAN / Wi-Fi subnet).

---

## 2. Packet Formats

All communication between nodes on UDP Port `43210` uses UTF-8 encoded JSON datagrams.

### A. Heartbeat Packet (`action: "heartbeat"`)
Emitted periodically (default every 3000ms) by `LanBeacon`:

```json
{
  "app": "sutram-lan",
  "version": "1.0.0",
  "action": "heartbeat",
  "nodeId": "sutram_macbook_7f9b8c",
  "nodeName": "Nast-MacBook",
  "host": "192.168.1.15",
  "port": 3300,
  "os": "darwin",
  "timestamp": 1794501234567,
  "projects": [
    {
      "id": "hisabkitab_2026",
      "name": "HisabKitab Main Store",
      "authType": "pin",
      "authRequired": true,
      "tablesCount": 24,
      "description": "Primary sales & ledger database",
      "updatedAt": 1794500000000
    }
  ]
}
```

### B. Farewell Packet (`action: "bye"`)
Emitted immediately when `lan.stop()` is called (application close or service stop):

```json
{
  "app": "sutram-lan",
  "version": "1.0.0",
  "action": "bye",
  "nodeId": "sutram_macbook_7f9b8c"
}
```

---

## 3. Security & Anti-Replay Handshake Flow

To protect against replay attacks or snooping on local Wi-Fi networks:

```mermaid
sequenceDiagram
    autonumber
    participant Client as Remote Sutram Client
    participant Server as Project Owner Server

    Note over Client,Server: Step 1: Request Challenge
    Client->>Server: POST /api/_sutram/lan/challenge { projectId: "hisabkitab_2026" }
    Server->>Server: Generate random 16-byte challenge
    Server-->>Client: 200 OK { challenge: "a7c8...9b", authType: "pin" }

    Note over Client,Server: Step 2: Compute Solution
    Client->>Client: Hash PIN with stored salt: pinHash = pbkdf2(pin, salt)
    Client->>Client: Compute HMAC: solution = hmac_sha256(pinHash, challenge)

    Note over Client,Server: Step 3: Verify Solution
    Client->>Server: POST /api/_sutram/lan/auth { challenge: "a7c8...9b", response: solution }
    Server->>Server: Verify timingSafeEqual(solution, expected)
    Server-->>Client: 200 OK { token: "HS256_SESSION_TOKEN", role: "editor" }

    Note over Client,Server: Step 4: Access Remote Data
    Client->>Server: GET /api/hisabkitab_2026/tables (Authorization: Bearer <token>)
    Server-->>Client: Returns live schema & records
```

---

## 4. Multi-User Concurrency & Transaction Safety

1. **Single-Writer Lock Principle**:
   - The database file remains exclusively on the hosting machine (`Machine A`).
   - Remote machines do not open the SQLite file directly over SMB.
   - All write mutations pass through `sutramEngine` on `Machine A`, ensuring atomic transactions and trigger pipelines execute sequentially and safely.
2. **WebSocket Sync Propagation**:
   - When a remote user updates a cell, the server processes the edit and broadcasts a WebSocket notification to all active peers, instantly keeping all connected screens in sync.
