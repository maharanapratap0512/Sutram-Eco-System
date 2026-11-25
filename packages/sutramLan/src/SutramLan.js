'use strict';

const { EventEmitter } = require('node:events');
const LanBeacon = require('./LanBeacon');
const LanScanner = require('./LanScanner');
const LanSecurity = require('./LanSecurity');

/**
 * SutramLan
 * Unified P2P LAN Network Discovery & Sharing Engine for Sutram.
 * Manages identity broadcast, peer scanning, live project sharing toggles,
 * and credential-protected access control.
 */
class SutramLan extends EventEmitter {
  constructor(options = {}) {
    super();

    this.nodeName = options.nodeName || 'Sutram Node';
    this.httpPort = options.httpPort || 3300;
    this.broadcastPort = options.broadcastPort || 43210;
    this.broadcastIntervalMs = options.broadcastIntervalMs || 3000;
    this.peerTtlMs = options.peerTtlMs || 10000;

    // Security & Challenge Store
    this.security = new LanSecurity({
      serverSecret: options.serverSecret,
      tokenTtlMs: options.tokenTtlMs
    });
    this.projectCredentials = new Map(); // projectId -> { authType, hash, salt }
    this.activeChallenges = new Map();   // challenge -> { projectId, createdAt }

    // Sub-components
    this.beacon = new LanBeacon({
      broadcastPort: this.broadcastPort,
      broadcastIntervalMs: this.broadcastIntervalMs,
      nodeName: this.nodeName,
      httpPort: this.httpPort
    });

    this.scanner = new LanScanner({
      broadcastPort: this.broadcastPort,
      selfNodeId: this.beacon.nodeId,
      peerTtlMs: this.peerTtlMs
    });

    this._forwardEvents();
  }

  /**
   * Forwards events from beacon and scanner
   */
  _forwardEvents() {
    this.scanner.on('peer:found', (peer) => this.emit('peer:found', peer));
    this.scanner.on('peer:updated', (peer) => this.emit('peer:updated', peer));
    this.scanner.on('peer:lost', (data) => this.emit('peer:lost', data));
    this.scanner.on('error', (err) => this.emit('error', err));
    this.beacon.on('error', (err) => this.emit('error', err));
  }

  /**
   * Starts both the LAN Beacon and LAN Scanner
   * @returns {Promise<void>}
   */
  async start() {
    await this.scanner.start();
    await this.beacon.start();
    this.emit('started', {
      nodeId: this.beacon.nodeId,
      nodeName: this.beacon.nodeName,
      httpPort: this.beacon.httpPort,
      broadcastPort: this.broadcastPort
    });
  }

  /**
   * Shares a local project on the LAN
   * @param {object} project - { id, name, authType, pin, password, tablesCount, description }
   */
  shareProject(project) {
    if (!project || !project.id) throw new Error('Project must have an id');
    const rawPin = project.pin !== undefined && project.pin !== null ? String(project.pin).trim() : '';
    const rawPassword = project.password !== undefined && project.password !== null ? String(project.password).trim() : '';

    let authType = project.authType || (rawPin ? 'pin' : (rawPassword ? 'password' : 'none'));
    if (authType === 'pin' && !rawPin) authType = 'none';
    if (authType === 'password' && !rawPassword) authType = 'none';

    // Store credentials securely if non-blank PIN/password is specified; blank automatically becomes open ('none')
    if (authType === 'pin') {
      const { hash, salt } = LanSecurity.hashSecret(rawPin);
      this.projectCredentials.set(project.id, { authType: 'pin', hash, salt });
    } else if (authType === 'password') {
      const { hash, salt } = LanSecurity.hashSecret(rawPassword);
      this.projectCredentials.set(project.id, { authType: 'password', hash, salt });
    } else {
      this.projectCredentials.delete(project.id);
    }

    this.beacon.shareProject({
      id: project.id,
      name: project.name || project.id,
      authType,
      tablesCount: project.tablesCount || 0,
      description: project.description || ''
    });
  }

  /**
   * Unshares a project, making it private and hidden from the network
   * @param {string} projectId
   */
  unshareProject(projectId) {
    this.projectCredentials.delete(projectId);
    this.beacon.unshareProject(projectId);
  }

  /**
   * Creates a challenge for a remote client requesting authentication
   * @param {string} projectId
   * @returns {{ challenge: string, authType: string }}
   */
  createAuthChallenge(projectId) {
    const cred = this.projectCredentials.get(projectId);
    const authType = cred ? cred.authType : 'none';
    const salt = cred ? cred.salt : null;
    const challenge = LanSecurity.createChallenge();

    this.activeChallenges.set(challenge, {
      projectId,
      createdAt: Date.now()
    });

    // Clean up stale challenges after 2 minutes
    setTimeout(() => this.activeChallenges.delete(challenge), 120000);

    return { challenge, authType, salt };
  }

  /**
   * Authenticates client response and issues session token
   * @param {string} challenge
   * @param {string} [response] - Optional HMAC solution
   * @param {string} [secret] - Optional direct PIN/password fallback
   * @returns {{ success: boolean, token?: string, error?: string }}
   */
  verifyAuthResponse(challenge, response, secret = null) {
    const chalData = this.activeChallenges.get(challenge);
    if (!chalData) {
      return { success: false, error: 'Challenge expired or invalid' };
    }
    this.activeChallenges.delete(challenge);

    const cred = this.projectCredentials.get(chalData.projectId);
    if (!cred) {
      // No auth required
      const token = this.security.issueToken({ projectId: chalData.projectId, role: 'viewer' });
      return { success: true, token };
    }

    let isValid = false;
    if (response) {
      isValid = LanSecurity.verifyChallengeSolution(response, cred.hash, challenge);
    } else if (secret) {
      isValid = LanSecurity.verifySecret(secret, cred.hash, cred.salt);
    }

    if (!isValid) {
      return { success: false, error: 'Invalid PIN or password' };
    }

    const token = this.security.issueToken({
      projectId: chalData.projectId,
      role: 'editor',
      authType: cred.authType
    });
    return { success: true, token };
  }

  /**
   * Verifies an incoming session token
   * @param {string} token
   * @returns {object|null} Decoded token payload if valid
   */
  verifyToken(token) {
    return this.security.verifyToken(token);
  }

  /**
   * Express middleware for protecting remote project endpoints
   * @param {string} [paramName='projectId']
   */
  authMiddleware(paramName = 'projectId') {
    return (req, res, next) => {
      const projId = req.params[paramName] || req.query[paramName] || req.body?.[paramName];
      const cred = this.projectCredentials.get(projId);

      // If project has no credentials set, allow through
      if (!cred || cred.authType === 'none') {
        return next();
      }

      // Check Authorization Bearer header
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required for this remote project',
          authRequired: true,
          authType: cred.authType
        });
      }

      const decoded = this.verifyToken(token);
      if (!decoded || decoded.projectId !== projId) {
        return res.status(403).json({
          success: false,
          error: 'Invalid or expired LAN access token',
          authRequired: true
        });
      }

      req.lanSession = decoded;
      next();
    };
  }

  /**
   * Returns discovered network peers
   * @returns {Array<object>}
   */
  getPeers() {
    return this.scanner.getPeers();
  }

  /**
   * Returns current node identity
   * @returns {object}
   */
  getNodeInfo() {
    return {
      nodeId: this.beacon.nodeId,
      nodeName: this.beacon.nodeName,
      host: LanBeacon.getLocalIpAddress(),
      httpPort: this.beacon.httpPort,
      sharedProjects: Array.from(this.beacon.projects.values())
    };
  }

  /**
   * Stops the SutramLan service
   * @returns {Promise<void>}
   */
  async stop() {
    await this.beacon.stop();
    await this.scanner.stop();
    this.emit('stopped');
  }
}

module.exports = SutramLan;
