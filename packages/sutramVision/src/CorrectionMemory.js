'use strict';

/**
 * CorrectionMemory
 * Stores user corrections and golden templates to provide
 * active continuous learning for Smart Mode prompts.
 */
class CorrectionMemory {
  constructor(options = {}) {
    // In-memory collection of corrections
    this.corrections = new Map(); // key: `${table}:${field}:${original_ocr}`
    this.goldenTemplates = new Map(); // key: table
    this.maxCorrectionsPerContext = options.maxCorrectionsPerContext || 20;
  }

  /**
   * Save a user correction pair
   * @param {Object} item
   * @param {string} item.original_ocr - What the OCR model misread
   * @param {string} item.corrected - What the user corrected it to
   * @param {string} [item.field] - Column or field name (e.g. 'particulars', 'qty')
   * @param {string} [item.table] - Target table or register name
   */
  addCorrection({ original_ocr, corrected, field = 'general', table = 'default' }) {
    if (!original_ocr || !corrected || original_ocr.trim() === corrected.trim()) {
      return null;
    }

    const key = `${table}:${field}:${original_ocr.trim().toLowerCase()}`;
    const record = {
      id: key,
      table,
      field,
      original_ocr: original_ocr.trim(),
      corrected: corrected.trim(),
      timestamp: Date.now(),
      frequency: (this.corrections.get(key)?.frequency || 0) + 1
    };

    this.corrections.set(key, record);
    return record;
  }

  /**
   * Get relevant corrections for a specific table/context
   * @param {string} [table]
   * @param {number} [limit=10]
   * @returns {Array<Object>}
   */
  getCorrections(table = 'default', limit = 10) {
    const list = [];
    for (const record of this.corrections.values()) {
      if (record.table === table || record.table === 'default') {
        list.push(record);
      }
    }
    // Sort by frequency (most common corrections first)
    list.sort((a, b) => b.frequency - a.frequency);
    return list.slice(0, limit);
  }

  /**
   * Save a verified Golden Template
   */
  saveGoldenTemplate(table, templateData) {
    if (!table || !templateData) return;
    this.goldenTemplates.set(table, {
      table,
      savedAt: Date.now(),
      data: templateData
    });
  }

  getGoldenTemplate(table) {
    return this.goldenTemplates.get(table) || null;
  }

  /**
   * Export all memory for persistence
   */
  exportData() {
    return {
      corrections: Array.from(this.corrections.values()),
      goldenTemplates: Array.from(this.goldenTemplates.values())
    };
  }

  /**
   * Load previously exported memory
   */
  importData(data = {}) {
    if (Array.isArray(data.corrections)) {
      data.corrections.forEach(c => this.addCorrection(c));
    }
    if (Array.isArray(data.goldenTemplates)) {
      data.goldenTemplates.forEach(t => this.saveGoldenTemplate(t.table, t.data));
    }
  }
}

module.exports = CorrectionMemory;
