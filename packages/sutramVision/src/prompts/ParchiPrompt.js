'use strict';

/**
 * ParchiPrompt
 * Specialized prompt & schema generator for Indian bazaar handwritten chits,
 * purchase slips, vouchers, bilti receipts, and multi-slip photo captures.
 */
class ParchiPrompt {
  /**
   * Build prompt and JSON schema for handwritten parchi/slips
   * @param {Object} options
   */
  static buildPrompt(options = {}) {
    const mode = options.mode || 'normal';
    const vocabulary = options.masterVocabulary || [];
    const corrections = options.corrections || [];

    let sys = `You are an expert Document Intelligence AI specialized in transcribing Indian handwritten purchase slips (कच्ची पर्ची / बिल / दैनिक हिसाब / खर्च पर्ची).\n`;
    sys += `Follow these rigorous accounting and transcription instructions:\n\n`;

    sys += `1. MULTI-SLIP & SINGLE-SLIP DETECTION:\n`;
    sys += `   - A single photo may contain 1, 2, or more separate paper slips (placed side-by-side or stacked on a desk or floor).\n`;
    sys += `   - Detect EACH slip separately with its own date, line items, total amount, and signee/PBK reference.\n`;
    sys += `   - MANDATORY: You MUST extract every slip visible in the photo. NEVER return an empty slips array if handwritten text exists.\n\n`;

    sys += `2. ITEM LINE PARSING RULES:\n`;
    sys += `   - Format A (Standard Line): "ItemName [specs] — QtyUnit @ Rate/- = Amount/-"\n`;
    sys += `     Extract item_name, specs (e.g. "160 pages", "Plastic", "50ml each"), qty, unit ("pc", "kg", "ली", "pkt", "नग", "सेट"), rate, and amount.\n`;
    sys += `   - Format B (Two-Line Split Items): Often an item name with specs is written on the top line (e.g. "Notebook (160 pages)" or "Folder (Plastic)"), and quantities, rate, and amount are on the next indented line (e.g. "— 100 pc @ 21.8/- = 2180/-"). You MUST MERGE them into ONE single item line: item_name: "Notebook", item_details: "160 pages", qty: 100, unit: "pc", rate: 21.8, amount: 2180.\n`;
    sys += `   - Format C (Omitted Rate): "ItemName — QtyUnit = Amount" (e.g. "तारपीन तेल - 2ली = 200.00", "Paint 1ली = 275.00")\n`;
    sys += `     Leave rate as null; the system will auto-calculate Rate = Amount / Qty.\n`;
    sys += `   - Format D (Sub-Items): e.g. "Duracell -> AAA 15pc" & "-> AA 15pc"\n`;
    sys += `     Extract item_name: "Duracell", sub_item: "AAA", item_name: "Duracell", sub_item: "AA".\n`;
    sys += `   - Format E (Expenses / Conveyance): e.g. "Battery Auto Rikshaw = 40/-" or "E-Rickshaw = 40/-" or "रिक्शा किराया = 350/-"\n`;
    sys += `     Classify as category: "Conveyance", item_name: "Battery Auto Rikshaw", qty: 1, unit: "", rate: 40, amount: 40.\n\n`;

    sys += `3. NUMERALS, DECIMALS & AMOUNTS:\n`;
    sys += `   - Write whole numbers normally without forced decimals (e.g. 44, 52, 200, 275, 2180, 4355).\n`;
    sys += `   - Preserve decimal points only when written in the slip (e.g. 21.8, 11.33, 27.75, 15.5, 46.4, 3.2, 4330.80).\n`;
    sys += `   - Handle fractions: ½ = 0.5, ¼ = 0.25.\n\n`;

    sys += `4. TOTALS, LESS & SIGNEE:\n`;
    sys += `   - Extract the written Total for the slip (e.g. Total = 4355/-, 2013/-, 1725/-, 975.00).\n`;
    sys += `   - If there is a "Less" or deduction line (e.g. "Total -> 4338.80, Less 8.80, Total -> 4330.80"):\n`;
    sys += `     extract discount_less: 8.80, and total_amount: 4330.80.\n`;
    sys += `   - Extract person / signee / department written at bottom (e.g. "प्र.ब्र.कु. मेहुल कुमार", "PBK विवेकानन्द").\n`;

    if (mode === 'smart') {
      if (corrections && corrections.length > 0) {
        sys += `\nPAST USER CORRECTIONS TO LEARN FROM:\n`;
        corrections.slice(0, 10).forEach(c => {
          sys += `- In field "${c.field}": read "${c.original_ocr}" as "${c.corrected}".\n`;
        });
      }

      if (vocabulary && vocabulary.length > 0) {
        sys += `\nKNOWN CATALOG MASTER ITEMS (Ground ambiguous handwriting to these terms):\n`;
        sys += vocabulary.slice(0, 50).join(', ') + '\n';
      }
    }

    sys += `\n5. OUTPUT JSON STRUCTURE EXAMPLE:\n`;
    sys += `{\n`;
    sys += `  "document_type": "parchi",\n`;
    sys += `  "slips": [\n`;
    sys += `    {\n`;
    sys += `      "slip_index": 1,\n`;
    sys += `      "date": "18/08/2026",\n`;
    sys += `      "signee": "प्र.ब्र.कु. मेहुल कुमार",\n`;
    sys += `      "total_amount": 4355,\n`;
    sys += `      "discount_less": 0,\n`;
    sys += `      "items": [\n`;
    sys += `        {\n`;
    sys += `          "item_name": "कास्टिक सोडा",\n`;
    sys += `          "sub_item": "",\n`;
    sys += `          "item_details": "",\n`;
    sys += `          "qty": 5,\n`;
    sys += `          "unit": "kg",\n`;
    sys += `          "rate": 70,\n`;
    sys += `          "amount": 350\n`;
    sys += `        },\n`;
    sys += `        {\n`;
    sys += `          "item_name": "Notebook",\n`;
    sys += `          "sub_item": "",\n`;
    sys += `          "item_details": "160 pages",\n`;
    sys += `          "qty": 100,\n`;
    sys += `          "unit": "pc",\n`;
    sys += `          "rate": 21.8,\n`;
    sys += `          "amount": 2180\n`;
    sys += `        },\n`;
    sys += `        {\n`;
    sys += `          "item_name": "Battery Auto Rikshaw",\n`;
    sys += `          "sub_item": "",\n`;
    sys += `          "item_details": "",\n`;
    sys += `          "qty": 1,\n`;
    sys += `          "unit": "",\n`;
    sys += `          "rate": 40,\n`;
    sys += `          "amount": 40,\n`;
    sys += `          "category": "Conveyance"\n`;
    sys += `        }\n`;
    sys += `      ]\n`;
    sys += `    }\n`;
    sys += `  ]\n`;
    sys += `}\n\n`;

    sys += `Output pure valid JSON matching the schema. Transcribe all lines without omitting any items.`;

    const userPrompt = 'Transcribe all handwritten slips in this image. Isolate multi-slips, extract item specs, units, rates, amounts, less deductions, and totals.';

    return {
      systemPrompt: sys,
      userPrompt,
      jsonSchema: this.getJsonSchema()
    };
  }

  static getJsonSchema() {
    return {
      type: 'object',
      properties: {
        document_type: { type: 'string', enum: ['parchi'] },
        slips: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              slip_index: { type: 'integer' },
              date: { type: 'string' },
              signee: { type: 'string' },
              subtotal: { type: 'number' },
              discount_less: { type: 'number' },
              total_amount: { type: 'number' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    item_name: { type: 'string' },
                    sub_item: { type: 'string' },
                    item_details: { type: 'string' },
                    qty: { type: 'number' },
                    unit: { type: 'string' },
                    rate: { type: 'number' },
                    amount: { type: 'number' },
                    category: { type: 'string' }
                  },
                  required: ['item_name']
                }
              }
            },
            required: ['items']
          }
        }
      },
      required: ['document_type', 'slips']
    };
  }
}

module.exports = ParchiPrompt;
