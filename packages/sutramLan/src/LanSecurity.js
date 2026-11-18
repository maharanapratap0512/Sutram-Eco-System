'use strict';

const crypto = require('node:crypto');

/**
 * LanSecurity
 * Cryptographic helpers for PIN verification, challenge-response auth,
 * and lightweight signed session tokens over local network.
 */
class LanSecurity {
  constructor(options = {}) {
    this.serverSecret = options.serverSecret || crypto.randomBytes(32).toString('hex');
    this.tokenTtlMs = options.tokenTtlMs || 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Hashes a user PIN or password with a unique salt
   * @param {string} secretText - Plaintext PIN or password
   * @param {string} [salt] - Optional salt (generated if omitted)
   * @returns {{ hash: string, salt: string }}
   */
  static hashSecret(secretText, salt = null) {
    if (!secretText) throw new Error('Secret text is required for hashing');
    const actualSalt = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(String(secretText), actualSalt, 10000, 32, 'sha256').toString('hex');
    return { hash, salt: actualSalt };
  }

  /**
   * Verifies a plain secret against stored hash and salt
   * @param {string} plainSecret - Plaintext PIN/password entered by user
   * @param {string} storedHash - Stored hash hex
   * @param {string} storedSalt - Stored salt hex
   * @returns {boolean}
   */
  static verifySecret(plainSecret, storedHash, storedSalt) {
    if (!plainSecret || !storedHash || !storedSalt) return false;
    try {
      const computed = crypto.pbkdf2Sync(String(plainSecret), storedSalt, 10000, 32, 'sha256').toString('hex');
      const bufA = Buffer.from(computed, 'hex');
      const bufB = Buffer.from(storedHash, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Generates a random cryptographic challenge string to prevent replay attacks
   * @returns {string} Hex challenge
   */
  static createChallenge() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Solves a challenge using secret hash
   * @param {string} secretHash - The pre-hashed secret
   * @param {string} challenge - The server-issued challenge
   * @returns {string} Response signature
   */
  static solveChallenge(secretHash, challenge) {
    return crypto.createHmac('sha256', secretHash).update(challenge).digest('hex');
  }

  /**
   * Verifies client challenge solution
   * @param {string} clientResponse - Client computed HMAC
   * @param {string} secretHash - Stored secret hash on server
   * @param {string} challenge - Challenge issued earlier
   * @returns {boolean}
   */
  static verifyChallengeSolution(clientResponse, secretHash, challenge) {
    if (!clientResponse || !secretHash || !challenge) return false;
    try {
      const expected = crypto.createHmac('sha256', secretHash).update(challenge).digest('hex');
      const bufA = Buffer.from(clientResponse, 'hex');
      const bufB = Buffer.from(expected, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Issues a signed base64url token for authenticated LAN session
   * @param {object} payload - Session payload (e.g. { nodeId, projectId, role, ip })
   * @returns {string} Signed token
   */
  issueToken(payload = {}) {
    const header = { alg: 'HS256', typ: 'SUTRAM-LAN' };
    const exp = Date.now() + this.tokenTtlMs;
    const body = { ...payload, exp, iat: Date.now() };

    const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const b64Body = Buffer.from(JSON.stringify(body)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.serverSecret)
      .update(`${b64Header}.${b64Body}`)
      .digest('base64url');

    return `${b64Header}.${b64Body}.${signature}`;
  }

  /**
   * Verifies and decodes a signed LAN session token
   * @param {string} token - The incoming token
   * @returns {object|null} Decoded payload if valid & unexpired, null otherwise
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [b64Header, b64Body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', this.serverSecret)
      .update(`${b64Header}.${b64Body}`)
      .digest('base64url');

    try {
      const bufSig = Buffer.from(signature);
      const bufExp = Buffer.from(expectedSig);
      if (bufSig.length !== bufExp.length) return null;
      const match = crypto.timingSafeEqual(bufSig, bufExp);
      if (!match) return null;

      const body = JSON.parse(Buffer.from(b64Body, 'base64url').toString('utf8'));
      if (body.exp && Date.now() > body.exp) {
        return null; // Expired
      }
      return body;
    } catch {
      return null;
    }
  }
}

module.exports = LanSecurity;
