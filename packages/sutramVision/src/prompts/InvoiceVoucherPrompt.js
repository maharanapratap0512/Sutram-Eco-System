'use strict';

/**
 * InvoiceVoucherPrompt
 * Specialized prompt & schema generator for handwritten invoices,
 * delivery chalans, transport bilti, and payment vouchers.
 */
class InvoiceVoucherPrompt {
  /**
   * Build system and user prompt for Invoice / Voucher OCR
   * @param {Object} options
   * @param {string} [options.mode] - 'normal' (eco token saver) vs 'smart' (adaptive learning)
   * @param {Array<string>} [options.targetColumns] - Expected line-item column hints
   * @param {Array<string>} [options.masterVocabulary] - Known master terms (parties, items)
   * @param {Array<Object>} [options.corrections] - Past user correction pairs
   */
  static buildPrompt(options = {}) {
    const mode = options.mode || 'normal';
    const targetCols = options.targetColumns || [];
    const vocabulary = options.masterVocabulary || [];
    const corrections = options.corrections || [];

    if (mode === 'normal') {
      // ⚡ Eco Mode: Minimum tokens
      let sys = `You are a high-speed OCR engine for handwritten invoices, bills, chalans, and vouchers.\n`;
      sys += `Extract document header metadata and all itemized line items as JSON.\n`;
      sys += `Output format: { "document_type": "invoice", "header": { "invoice_no": "...", "date": "...", "party_name": "...", "total_amount": 0 }, "items": [ { "item_name": "...", "qty": 0, "rate": 0, "amount": 0 } ] }`;

      let user = 'Extract invoice header and line items as JSON.';
      return { systemPrompt: sys, userPrompt: user, jsonSchema: this.getJsonSchema() };
    }

    // 🧠 Smart Mode: Adaptive Learning with Corrections & Master Vocabulary
    let sys = `You are an expert Document Intelligence AI specialized in handwritten trade invoices, bilti, transport receipts, and bills.\n`;
    sys += `Extraction Requirements:\n`;
    sys += `1. Header: Extract invoice number, date, vendor/supplier, purchaser/consignee, GSTIN/PAN, and vehicle number.\n`;
    sys += `2. Line Items: Extract each table row (description, quantity, unit, rate, amount, tax).\n`;
    sys += `3. Arithmetic Cross-Check: Verify quantity * rate = amount and reconcile sum of items with subtotal/grand total.\n`;

    if (corrections && corrections.length > 0) {
      sys += `\nPAST CORRECTIONS TO LEARN FROM:\n`;
      corrections.slice(0, 10).forEach(c => {
        sys += `- "${c.original_ocr}" should be read as "${c.corrected}".\n`;
      });
    }

    if (vocabulary && vocabulary.length > 0) {
      sys += `\nKNOWN CATALOG ENTITIES:\n`;
      sys += vocabulary.slice(0, 50).join(', ') + '\n';
    }

    sys += `\nOutput pure valid JSON matching the schema.`;
    let user = 'Extract handwritten invoice data with mathematical validation and vocabulary grounding.';

    return { systemPrompt: sys, userPrompt: user, jsonSchema: this.getJsonSchema() };
  }

  static getJsonSchema() {
    return {
      type: 'object',
      properties: {
        document_type: { type: 'string', enum: ['invoice'] },
        header: {
          type: 'object',
          properties: {
            invoice_no: { type: 'string' },
            date: { type: 'string' },
            party_name: { type: 'string' },
            vehicle_no: { type: 'string' },
            total_amount: { type: 'number' }
          }
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item_name: { type: 'string' },
              qty: { type: 'number' },
              unit: { type: 'string' },
              rate: { type: 'number' },
              amount: { type: 'number' }
            },
            required: ['item_name']
          }
        }
      },
      required: ['document_type', 'header', 'items']
    };
  }
}

module.exports = InvoiceVoucherPrompt;
