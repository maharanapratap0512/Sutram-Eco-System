'use strict';

/**
 * DocumentParser
 * Cleans, sanitizes, normalizes, and validates raw VLM JSON extractions.
 */
class DocumentParser {
  /**
   * Helper to format numbers cleanly:
   * Keeps whole numbers as integers (52, 200, 44),
   * only keeps up to 2 decimal places if fractional (21.78, 15.5, 46.4).
   */
  static cleanNumber(val) {
    if (val === undefined || val === null || val === '') return '';
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return '';
    if (Number.isInteger(num)) return num;
    return Math.round(num * 100) / 100;
  }

  /**
   * Normalize handwritten parchi / purchase slips
   * Supports:
   * 1. Multi-slip single capture (decomposes 2 or more slips from 1 photo)
   * 2. Auto-Rate calculation: Rate = Amount / Qty when @ rate is omitted
   * 3. Item, Sub-item, and Details separation
   * 4. Slip total & discount/roundoff placed strictly on the LAST row of each slip
   * 5. Universal schema tolerance (handles any JSON wrapper, flat arrays, or alternate property names)
   */
  static normalizeParchi(raw, options = {}) {
    if (!raw) return { slipsCount: 0, rows: [], columns: this.getParchiStandardColumns() };

    let doc = raw;
    if (doc && !doc.slips && doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)) {
      doc = doc.data;
    }

    let rawSlips = [];

    // Case 1: Root is directly an array
    if (Array.isArray(doc)) {
      if (doc.length > 0 && (doc[0].items || doc[0].rows || doc[0].line_items || doc[0].date || doc[0].slip_index || doc[0].total_amount)) {
        rawSlips = doc;
      } else {
        rawSlips = [{ items: doc }];
      }
    } else if (doc && typeof doc === 'object') {
      // Case 2: Object with various possible keys
      let slipArrayCandidates = doc.slips || doc.parchi || doc.documents || doc.receipts || doc.slips_data || doc.vouchers || doc.bills || doc.records || (Array.isArray(doc.data) ? doc.data : null);

      // Check if slips array is empty, but other slip keys exist (e.g. slip1, slip2, slip)
      if ((!slipArrayCandidates || (Array.isArray(slipArrayCandidates) && slipArrayCandidates.length === 0))) {
        if (doc.slip && typeof doc.slip === 'object') {
          slipArrayCandidates = Array.isArray(doc.slip) ? doc.slip : [doc.slip];
        } else {
          // Check for numbered slip keys (slip1, slip2, slip_1, etc.)
          const numberedSlips = Object.keys(doc)
            .filter(k => /^slip[_\s\d]/i.test(k) || /^parchi[_\s\d]/i.test(k) || /^page[_\s\d]/i.test(k))
            .map(k => doc[k])
            .filter(v => v && typeof v === 'object');
          if (numberedSlips.length > 0) {
            slipArrayCandidates = numberedSlips;
          }
        }
      }

      if (Array.isArray(slipArrayCandidates) && slipArrayCandidates.length > 0) {
        rawSlips = slipArrayCandidates;
      } else if (slipArrayCandidates && typeof slipArrayCandidates === 'object') {
        rawSlips = Object.values(slipArrayCandidates);
      } else if (Array.isArray(doc.items)) {
        rawSlips = [doc];
      } else if (Array.isArray(doc.line_items)) {
        rawSlips = [{ items: doc.line_items, ...doc }];
      } else if (Array.isArray(doc.rows)) {
        rawSlips = [{ items: doc.rows, ...doc }];
      } else if (Array.isArray(doc.entries)) {
        rawSlips = [{ items: doc.entries, ...doc }];
      } else if (Array.isArray(doc.lines)) {
        rawSlips = [{ items: doc.lines, ...doc }];
      } else if (Array.isArray(doc.transactions)) {
        rawSlips = [{ items: doc.transactions, ...doc }];
      } else if (doc.item_name || doc.item || doc.particulars || doc.amount) {
        // Single line item object
        rawSlips = [{ items: [doc] }];
      } else {
        // Deep search: Find any property in doc that contains an array of items
        for (const [k, v] of Object.entries(doc)) {
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
            const hasItemLike = v.some(x => x.item_name || x.item || x.name || x.particulars || x.amount || x.qty || x.rate);
            if (hasItemLike) {
              rawSlips = [{ items: v, ...doc }];
              break;
            }
          }
        }
      }
    }

    const startSlipNum = options.startSlipNumber || 1;
    const flattenedRows = [];

    rawSlips.forEach((slip, sIdx) => {
      const slipNumber = `Slip ${startSlipNum + sIdx}`;
      const slipDate = slip.date || slip.slip_date || options.fallbackDate || '';
      const slipSignee = slip.signee || slip.sign || slip.person || slip.pbk || '';
      const totalAmount = this.cleanNumber(slip.total_amount !== undefined ? slip.total_amount : (slip.total !== undefined ? slip.total : (slip.final_total !== undefined ? slip.final_total : slip.grand_total)));
      const discountLess = slip.discount_less !== undefined && slip.discount_less !== null
        ? this.cleanNumber(slip.discount_less)
        : (slip.less !== undefined ? this.cleanNumber(slip.less) : (slip.discount !== undefined ? this.cleanNumber(slip.discount) : null));

      // Extract item array with multiple fallbacks
      let items = [];
      if (Array.isArray(slip.items)) items = slip.items;
      else if (Array.isArray(slip.line_items)) items = slip.line_items;
      else if (Array.isArray(slip.rows)) items = slip.rows;
      else if (Array.isArray(slip.particulars)) items = slip.particulars;
      else if (Array.isArray(slip.entries)) items = slip.entries;
      else if (Array.isArray(slip.products)) items = slip.products;
      else if (Array.isArray(slip.lines)) items = slip.lines;
      else if (Array.isArray(slip.goods)) items = slip.goods;
      else if (Array.isArray(slip.materials)) items = slip.materials;
      else if (slip.items && typeof slip.items === 'object') items = Object.values(slip.items);
      else if (slip && typeof slip === 'object' && (slip.item_name || slip.item || slip.particulars || slip.amount)) {
        items = [slip];
      }

      items.forEach((item, itemIdx) => {
        const isLastRow = itemIdx === items.length - 1;

        const qty = this.cleanNumber(item.qty !== undefined ? item.qty : (item.quantity !== undefined ? item.quantity : item.qnt));
        let amount = this.cleanNumber(item.amount !== undefined ? item.amount : (item.total !== undefined ? item.total : (item.net_amount !== undefined ? item.net_amount : (item.cost !== undefined ? item.cost : item.rakam))));
        let rate = this.cleanNumber(item.rate !== undefined ? item.rate : (item.price !== undefined ? item.price : (item.unit_price !== undefined ? item.unit_price : item.dar)));

        // Auto-calculate rate if omitted: Rate = Amount / Qty
        let isDerivedRate = false;
        if ((rate === '' || rate === 0) && qty !== '' && qty > 0 && amount !== '' && amount > 0) {
          const rawRate = amount / qty;
          rate = Number.isInteger(rawRate) ? rawRate : Math.round(rawRate * 100) / 100;
          isDerivedRate = true;
        } else if ((amount === '' || amount === 0) && qty !== '' && qty > 0 && rate !== '' && rate > 0) {
          const rawAmt = qty * rate;
          amount = Number.isInteger(rawAmt) ? rawAmt : Math.round(rawAmt * 100) / 100;
        }

        // Sub-item vs Item Name vs Details
        let itemName = (
          item.item_name ||
          item.item ||
          item.particulars ||
          item.name ||
          item.description ||
          item.title ||
          item.material ||
          ''
        ).trim();

        let subItem = (
          item.sub_item ||
          item.subitem ||
          item.variant ||
          item.type ||
          ''
        ).trim();

        let itemDetails = (
          item.item_details ||
          item.specs ||
          item.details ||
          item.specification ||
          item.note ||
          ''
        ).trim();

        // Skip completely empty lines
        if (!itemName && amount === '' && qty === '') return;

        // Detect conveyance / freight category
        let category = item.category || 'Item';
        const nameLower = itemName.toLowerCase();
        if (nameLower.includes('rickshaw') || nameLower.includes('auto') || itemName.includes('किराया') || itemName.includes('भाड़ा')) {
          category = 'Conveyance';
        }

        // Row structure
        const rowObj = {
          slip_no: slipNumber,
          date: slipDate,
          item_name: itemName,
          sub_item: subItem,
          item_details: itemDetails,
          qty: qty,
          unit: (item.unit || item.uom || item.measure || '').trim(),
          rate: rate,
          amount: amount,
          category: category,
          signee: slipSignee,
          // Discount / Round-off only on the LAST item row of this slip
          discount_roundoff: isLastRow && discountLess !== null && discountLess > 0 ? -discountLess : '',
          // Slip Total only on the LAST item row of this slip
          slip_total: isLastRow ? (totalAmount !== '' ? totalAmount : amount) : '',
          _is_rate_derived: isDerivedRate
        };

        flattenedRows.push(rowObj);
      });
    });

    const standardColumns = this.getParchiStandardColumns();

    return {
      documentType: 'parchi',
      detectedTitle: `पर्ची हिसाब (${rawSlips.length} Slips)`,
      slipsCount: rawSlips.length,
      columns: standardColumns,
      rows: flattenedRows
    };
  }

  static getParchiStandardColumns() {
    return [
      { key: 'slip_no', header_text: 'पर्ची क्र. / Slip #' },
      { key: 'date', header_text: 'तारीख / Date' },
      { key: 'item_name', header_text: 'सामग्री / Item' },
      { key: 'sub_item', header_text: 'उप-सामग्री / Sub-Item' },
      { key: 'item_details', header_text: 'विवरण / Specs' },
      { key: 'qty', header_text: 'मात्रा / Qty' },
      { key: 'unit', header_text: 'इकाई / Unit' },
      { key: 'rate', header_text: 'दर / Rate' },
      { key: 'amount', header_text: 'रकम / Amount' },
      { key: 'category', header_text: 'श्रेणी / Category' },
      { key: 'signee', header_text: 'हस्ताक्षर / Signee' },
      { key: 'discount_roundoff', header_text: 'छूट / Round Off' },
      { key: 'slip_total', header_text: 'पर्ची कुल / Slip Total' }
    ];
  }

  /**
   * Normalize tabular register response (Aawak-Jawak)
   */
  static normalizeTabularRegister(raw, options = {}) {
    let doc = raw;
    if (doc && !doc.rows && doc.data && Array.isArray(doc.data.rows)) {
      doc = doc.data;
    }

    const columns = Array.isArray(doc.columns) ? doc.columns : [];
    let rows = Array.isArray(doc.rows) ? doc.rows : [];

    rows = this.resolveDittoMarks(rows);
    rows = this.validateRowArithmetic(rows);

    return {
      documentType: 'tabular_register',
      detectedTitle: doc.detected_title || 'Tabular Register',
      columns: columns.map(c => typeof c === 'string' ? { key: c, header_text: c } : c),
      rows
    };
  }

  /**
   * Normalize invoice response
   */
  static normalizeInvoice(raw, options = {}) {
    let doc = raw;
    if (doc && !doc.items && doc.data && Array.isArray(doc.data.items)) {
      doc = doc.data;
    }

    const header = doc.header || {};
    const items = Array.isArray(doc.items) ? doc.items : [];

    const flattenedRows = items.map((item, idx) => ({
      _sr_no: idx + 1,
      invoice_no: header.invoice_no || '',
      invoice_date: header.date || '',
      party_name: header.party_name || '',
      vehicle_no: header.vehicle_no || '',
      item_name: item.item_name || '',
      qty: this.cleanNumber(item.qty),
      unit: item.unit || '',
      rate: this.cleanNumber(item.rate),
      amount: this.cleanNumber(item.amount),
      total_amount: this.cleanNumber(header.total_amount)
    }));

    return {
      documentType: 'invoice',
      header,
      items,
      rows: flattenedRows
    };
  }

  /**
   * Resolve ditto marks ('"', '-do-', 'same') by carrying forward the above value
   */
  static resolveDittoMarks(rows = []) {
    const isDitto = val => {
      if (typeof val !== 'string') return false;
      const s = val.trim();
      return s === '"' || s === '""' || s === "''" || s.toLowerCase() === '-do-' || s.toLowerCase() === 'do' || s.toLowerCase() === 'same';
    };

    const lastSeen = {};

    return rows.map(row => {
      const cleanRow = { ...row };
      for (const key of Object.keys(cleanRow)) {
        if (isDitto(cleanRow[key])) {
          cleanRow[key] = lastSeen[key] !== undefined ? lastSeen[key] : '';
        } else if (cleanRow[key] !== undefined && cleanRow[key] !== null && cleanRow[key] !== '') {
          lastSeen[key] = cleanRow[key];
        }
      }
      return cleanRow;
    });
  }

  /**
   * Validate row arithmetic (e.g. qty * rate == amount)
   */
  static validateRowArithmetic(rows = []) {
    return rows.map(row => {
      const copy = { ...row };
      const warnings = [];

      const qty = parseFloat(copy.qty || copy.quantity);
      const rate = parseFloat(copy.rate || copy.price);
      const amount = parseFloat(copy.amount || copy.total);

      if (!isNaN(qty) && !isNaN(rate) && !isNaN(amount) && qty > 0 && rate > 0) {
        const expected = Math.round(qty * rate * 100) / 100;
        if (Math.abs(expected - amount) > 1) {
          warnings.push(`Math mismatch: ${qty} * ${rate} = ${expected}, but extracted ${amount}`);
        }
      }

      if (warnings.length > 0) {
        copy._warnings = warnings;
      }
      return copy;
    });
  }
}

module.exports = DocumentParser;
