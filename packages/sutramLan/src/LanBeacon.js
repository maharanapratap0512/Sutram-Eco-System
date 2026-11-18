'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const { EventEmitter } = require('node:events');

/**
 * LanBeacon
 * Periodically broadcasts this machine's Sutram node identity and its
 * live/shared projects to the local network subnet via UDP broadcast.
 */
class LanBeacon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.broadcastPort = options.broadcastPort || 43210;
    this.broadcastIntervalMs = options.broadcastIntervalMs || 3000;
    this.nodeId = options.nodeId || `sutram_${os.hostname()}_${Math.random().toString(36).slice(2, 9)}`;
    this.nodeName = options.nodeName || os.hostname() || 'Sutram Node';
    this.httpPort = options.httpPort || 3300;
    this.customHost = options.host || null;
    this.projects = new Map(); // id -> projectMetadata
    
    this.socket = null;
    this.timer = null;
    this.isRunning = false;
  }

  /**
   * Discovers primary local IPv4 address
   * @returns {string} Local IPv4 (e.g. 192.168.1.15)
   */
  static getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const net of interfaces[name]) {
        // Skip over non-IPv4 and internal/loopback addresses
        if (net.family === 'IPv4' && !net.internal) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }

  /**
   * Registers a project to be advertised on the local network
   * @param {object} project - { id, name, authType, tablesCount, description }
   */
  shareProject(project) {
    if (!project || !project.id) throw new Error('Project must have an id');
    this.projects.set(project.id, {
      id: project.id,
      name: project.name || project.id,
      authType: project.authType || 'none', // 'none' | 'pin' | 'password'
      authRequired: project.authType && project.authType !== 'none',
      tablesCount: project.tablesCount || 0,
      description: project.description || '',
      updatedAt: Date.now()
    });
    // Immediately broadcast project state update
    if (this.isRunning) {
      this.sendHeartbeat();
    }
  }

  /**
   * Stops advertising a project on the network
   * @param {string} projectId
   */
  unshareProject(projectId) {
    if (this.projects.has(projectId)) {
      this.projects.delete(projectId);
      if (this.isRunning) {
        this.sendHeartbeat();
      }
    }
  }

  /**
   * Starts broadcasting on the LAN
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

        this.socket.bind(0, () => {
          try {
            this.socket.setBroadcast(true);
            this.isRunning = true;
            this.sendHeartbeat();
            this.timer = setInterval(() => this.sendHeartbeat(), this.broadcastIntervalMs);
            resolve();
          } catch (bindErr) {
            reject(bindErr);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Constructs the beacon payload
   * @returns {object}
   */
  buildPayload() {
    return {
      app: 'sutram-lan',
      version: '1.0.0',
      action: 'heartbeat',
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      host: this.customHost || LanBeacon.getLocalIpAddress(),
      port: this.httpPort,
      os: os.platform(),
      timestamp: Date.now(),
      projects: Array.from(this.projects.values())
    };
  }

  /**
   * Sends a single broadcast beacon packet
   */
  sendHeartbeat() {
    if (!this.socket || !this.isRunning) return;

    try {
      const payload = JSON.stringify(this.buildPayload());
      const message = Buffer.from(payload, 'utf8');

      // Send to 255.255.255.255 broadcast address
      this.socket.send(message, 0, message.length, this.broadcastPort, '255.255.255.255', (err) => {
        if (err) {
          this.emit('broadcast:error', err);
        } else {
          this.emit('broadcast:sent', { timestamp: Date.now() });
        }
      });
    } catch (err) {
      this.emit('broadcast:error', err);
    }
  }

  /**
   * Gracefully stops the beacon and notifies peers
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning) return resolve();

      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      // Send farewell packet
      if (this.socket) {
        try {
          const byeMsg = Buffer.from(JSON.stringify({
            app: 'sutram-lan',
            version: '1.0.0',
            action: 'bye',
            nodeId: this.nodeId
          }), 'utf8');

          this.socket.send(byeMsg, 0, byeMsg.length, this.broadcastPort, '255.255.255.255', () => {
            try { this.socket.close(); } catch {}
            this.socket = null;
            this.isRunning = false;
            resolve();
          });
        } catch {
          try { this.socket.close(); } catch {}
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

module.exports = LanBeacon;
