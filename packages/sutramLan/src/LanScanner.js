'use strict';

const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');

/**
 * LanScanner
 * Listens for LAN beacons from other Sutram nodes, maintains an active peer table,
 * detects offline/expired peers, and emits lifecycle discovery events.
 */
class LanScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.broadcastPort = options.broadcastPort || 43210;
    this.selfNodeId = options.selfNodeId || '';
    this.peerTtlMs = options.peerTtlMs || 10000; // 10s timeout
    this.pruneIntervalMs = options.pruneIntervalMs || 4000;

    this.peers = new Map(); // nodeId -> PeerInfo
    this.socket = null;
    this.pruneTimer = null;
    this.isRunning = false;
  }

  /**
   * Starts listening for LAN peer announcements
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      if (this.isRunning) return resolve();

      try {
        this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.socket.on('error', (err) => {
          this.emit('error', err);
        });

        this.socket.on('message', (msg, rinfo) => {
          this.handleIncomingPacket(msg, rinfo);
        });

        this.socket.bind(this.broadcastPort, () => {
          this.isRunning = true;
          this.pruneTimer = setInterval(() => this.pruneDeadPeers(), this.pruneIntervalMs);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Processes an incoming UDP packet
   * @param {Buffer} msg
   * @param {object} rinfo - { address, port }
   */
  handleIncomingPacket(msg, rinfo) {
    let packet;
    try {
      packet = JSON.parse(msg.toString('utf8'));
    } catch {
      return; // Ignore non-JSON or corrupted packets
    }

    if (!packet || packet.app !== 'sutram-lan') return;
    if (this.selfNodeId && packet.nodeId === this.selfNodeId) return; // Ignore own echoes

    const { nodeId, action } = packet;
    if (!nodeId) return;

    // 1. Handle graceful peer disconnect
    if (action === 'bye') {
      if (this.peers.has(nodeId)) {
        const peer = this.peers.get(nodeId);
        this.peers.delete(nodeId);
        this.emit('peer:lost', { nodeId, peer, reason: 'graceful_exit' });
      }
      return;
    }

    // 2. Handle peer heartbeat
    if (action === 'heartbeat') {
      const now = Date.now();
      const peerData = {
        nodeId: packet.nodeId,
        nodeName: packet.nodeName || 'Unknown Node',
        host: packet.host || rinfo.address,
        port: packet.port || 3300,
        os: packet.os || 'unknown',
        projects: Array.isArray(packet.projects) ? packet.projects : [],
        lastSeen: now,
        isRemote: true
      };

      if (!this.peers.has(nodeId)) {
        this.peers.set(nodeId, peerData);
        this.emit('peer:found', peerData);
      } else {
        const existing = this.peers.get(nodeId);
        const projectsChanged = JSON.stringify(existing.projects) !== JSON.stringify(peerData.projects);
        const nameChanged = existing.nodeName !== peerData.nodeName;

        this.peers.set(nodeId, peerData);

        if (projectsChanged || nameChanged) {
          this.emit('peer:updated', peerData);
        }
      }
    }
  }

  /**
   * Prunes peers that have not sent a heartbeat within the TTL window
   */
  pruneDeadPeers() {
    const now = Date.now();
    for (const [nodeId, peer] of this.peers.entries()) {
      if (now - peer.lastSeen > this.peerTtlMs) {
        this.peers.delete(nodeId);
        this.emit('peer:lost', { nodeId, peer, reason: 'timeout' });
      }
    }
  }

  /**
   * Returns list of all active discovered peers
   * @returns {Array<object>}
   */
  getPeers() {
    return Array.from(this.peers.values());
  }

  /**
   * Retrieves a specific peer by ID
   * @param {string} nodeId
   * @returns {object|null}
   */
  getPeer(nodeId) {
    return this.peers.get(nodeId) || null;
  }

  /**
   * Stops the scanner
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning) return resolve();

      if (this.pruneTimer) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = null;
      }

      if (this.socket) {
        try {
          this.socket.close(() => {
            this.socket = null;
            this.isRunning = false;
            resolve();
          });
        } catch {
          this.socket = null;
          this.isRunning = false;
          resolve();
        }
      } else {
        this.isRunning = false;
        resolve();
      }
    });
  }
}

module.exports = LanScanner;
