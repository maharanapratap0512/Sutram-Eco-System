'use strict';

/**
 * RegisterTabularPrompt
 * Specialized prompt & schema generator for Aawak-Jawak registers,
 * daily inward/outward logbooks, and tabular ledgers with top headers.
 */
class RegisterTabularPrompt {
  /**
   * Build system and user prompt for Tabular Register OCR
   * @param {Object} options
   * @param {string} [options.mode] - 'normal' (eco token saver) vs 'smart' (adaptive learning)
   * @param {Array<string>} [options.targetColumns] - Expected column hints from target sheet
   * @param {Array<string>} [options.masterVocabulary] - Known master terms (items, units) for grounding
   * @param {Array<Object>} [options.corrections] - Past user correction pairs
   */
  static buildPrompt(options = {}) {
    const mode = options.mode || 'normal';
    const targetCols = options.targetColumns || [];
    const vocabulary = options.masterVocabulary || [];
    const corrections = options.corrections || [];

    if (mode === 'normal') {
      // ⚡ Eco Mode: Absolute minimum tokens, zero fluff
      let sys = `You are a specialized OCR engine for handwritten tabular registers and daily inward/outward (Aawak-Jawak) logbooks.\n`;
      sys += `Task: Detect the top column headers and extract every row as structured tabular data.\n`;
      sys += `Rules:\n`;
      sys += `1. Extract top printed/written column headers precisely.\n`;
      sys += `2. If a cell contains ditto marks (" or -do-), resolve it to the value directly above it.\n`;
      sys += `3. Accurately transcribe handwritten Hindi, Roman Hindi, English text, and numerals.\n`;
      sys += `4. Keep blank cells as empty string or null.\n`;
      sys += `5. Output valid JSON: { "document_type": "tabular_register", "columns": [...], "rows": [...] }`;

      let user = 'Extract all rows from this register sheet into the JSON structure.';
      if (targetCols.length > 0) {
        user += `\nAlign extraction to these expected columns where possible: ${targetCols.join(', ')}`;
      }

      return { systemPrompt: sys, userPrompt: user, jsonSchema: this.getJsonSchema(targetCols) };
    }

    // 🧠 Smart Mode: Adaptive Learning with Corrections & Master Vocabulary
    let sys = `You are an expert Handwriting OCR & Ledger Accounting AI specialized in Devanagari and English Aawak-Jawak registers.\n`;
    sys += `Follow these rigorous accounting extraction standards:\n`;
    sys += `1. Table Structure: Detect the table grid, top column headers, and all handwritten rows in sequential order.\n`;
    sys += `2. Shorthand & Dittos: Resolve ditto marks (" or -do-) to the previous row's value.\n`;
    sys += `3. Mathematical Cross-Validation: Where columns represent Opening + Inward - Outward = Balance, verify numbers against row arithmetic.\n`;
    sys += `4. Numerals: Distinguish carefully between handwritten 0/6, 1/7, 4/8, and Devanagari numerals (०,१,२,३,४,५,६,७,८,९).\n`;

    if (corrections && corrections.length > 0) {
      sys += `\nPAST USER CORRECTIONS & HANDWRITING GUIDANCE (Learn from these mistakes):\n`;
      corrections.slice(0, 10).forEach(c => {
        sys += `- In field "${c.field || 'general'}": When handwriting resembles "${c.original_ocr}", the intended word is "${c.corrected}".\n`;
      });
    }

    if (vocabulary && vocabulary.length > 0) {
      sys += `\nKNOWN MASTER VOCABULARY (Ground ambiguous handwriting to these valid terms):\n`;
      sys += vocabulary.slice(0, 50).join(', ') + '\n';
    }

    sys += `\nOutput pure valid JSON matching the schema.`;

    let user = 'Perform smart extraction on this handwritten register page. Apply mathematical self-checks and vocabulary grounding.';
    if (targetCols.length > 0) {
      user += `\nTarget table columns: ${targetCols.join(', ')}`;
    }

    return { systemPrompt: sys, userPrompt: user, jsonSchema: this.getJsonSchema(targetCols) };
  }

  static getJsonSchema(targetCols = []) {
    const rowProperties = {};
    if (targetCols && targetCols.length > 0) {
      targetCols.forEach(col => {
        rowProperties[col] = { type: 'string' };
      });
    } else {
      ['date', 'voucher_no', 'particulars', 'inward_qty', 'outward_qty', 'balance', 'remarks', 'sign'].forEach(k => {
        rowProperties[k] = { type: 'string' };
      });
    }

    return {
      type: 'object',
      properties: {
        document_type: { type: 'string', enum: ['tabular_register'] },
        detected_title: { type: 'string' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              header_text: { type: 'string' },
              type: { type: 'string' }
            },
            required: ['key', 'header_text']
          }
        },
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: rowProperties
          }
        }
      },
      required: ['document_type', 'columns', 'rows']
    };
  }
}

module.exports = RegisterTabularPrompt;
