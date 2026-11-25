'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENC_PREFIX = 'enc$';
const MASTER_TTL_MS = 24 * 60 * 60 * 1000;
const PROJECT_TTL_MS = 24 * 60 * 60 * 1000;
const UNMASK_TTL_MS = 30 * 60 * 1000;

class SessionManager {
  constructor(dataDir) {
    this.secretPath = path.resolve(dataDir, '.sutram_secret');
    this._hmacKey = this._loadOrCreateSecret();
    this._aesKey = crypto.createHash('sha256').update(this._hmacKey).digest();
  }

  _loadOrCreateSecret() {
    try {
      if (fs.existsSync(this.secretPath)) {
        const hex = fs.readFileSync(this.secretPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(hex)) {
          return Buffer.from(hex, 'hex');
        }
      }
      const generated = crypto.randomBytes(32);
      fs.writeFileSync(this.secretPath, generated.toString('hex'), { mode: 0o600 });
      try { fs.chmodSync(this.secretPath, 0o600); } catch {}
      return generated;
    } catch {
      return crypto.randomBytes(32);
    }
  }

  _sign(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', this._hmacKey).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verifyToken(token, expectedKind = null) {
    if (!token || typeof token !== 'string') return null;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0) return null;

    const body = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    if (!body || !sig) return null;

    try {
      const expectedSig = crypto.createHmac('sha256', this._hmacKey).update(body).digest('base64url');
      const sigBuf = Buffer.from(sig, 'utf8');
      const expBuf = Buffer.from(expectedSig, 'utf8');
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return null;
      }

      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object') return null;
      if (payload.exp && Date.now() > Number(payload.exp)) return null;
      if (expectedKind && payload.kind !== expectedKind) return null;
      return payload;
    } catch {
      return null;
    }
  }

  issueMasterToken(user) {
    const now = Date.now();
    return this._sign({
      kind: 'master',
      uid: Number(user._id),
      username: user.username,
      role: user.role,
      iat: now,
      exp: now + MASTER_TTL_MS
    });
  }

  issueProjectToken(slug, user) {
    const now = Date.now();
    return this._sign({
      kind: 'project',
      slug: String(slug),
      uid: Number(user._id),
      username: user.username,
      role: user.role,
      iat: now,
      exp: now + PROJECT_TTL_MS
    });
  }

  issueUnmaskToken(slug, uid, table, column) {
    const now = Date.now();
    return this._sign({
      kind: 'unmask',
      slug: String(slug),
      uid: Number(uid),
      table: String(table || '*'),
      column: String(column || '*'),
      iat: now,
      exp: now + UNMASK_TTL_MS
    });
  }

  encryptSecret(plaintext) {
    const raw = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext ?? {});
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('hex')}$${tag.toString('hex')}$${encrypted.toString('hex')}`;
  }

  decryptSecret(value) {
    if (!value) return '';
    const str = String(value);
    if (!str.startsWith(ENC_PREFIX)) return str;
    try {
      const parts = str.slice(ENC_PREFIX.length).split('$');
      if (parts.length !== 3) return '';
      const [ivHex, tagHex, encHex] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', this._aesKey, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  sanitizeProjectForApi(project) {
    if (!project) return null;
    const copy = { ...project };
    let mysqlSummary = null;
    if (copy.db_type === 'mysql' && copy.db_config) {
      try {
        const raw = this.decryptSecret(copy.db_config);
        const cfg = JSON.parse(raw);
        mysqlSummary = {
          host: cfg.host || 'localhost',
          port: Number(cfg.port || 3306),
          database: cfg.database || copy.db_file
        };
      } catch {}
    }
    delete copy.db_config;
    if (mysqlSummary) {
      copy.mysql_database = mysqlSummary.database;
      copy.mysql_summary = mysqlSummary;
    }
    return copy;
  }
}

module.exports = SessionManager;
