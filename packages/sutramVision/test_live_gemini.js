'use strict';

const fs = require('fs');
const path = require('path');
const { SutramVision } = require('./index');
const Database = require('better-sqlite3');

async function main() {
  console.log('🔍 [SutramVision Live Test Runner]');

  // 1. Check API Key from CLI argument, environment, or database sys_meta
  let apiKey = process.argv[2] || process.env.GEMINI_API_KEY;

  if (!apiKey) {
    // Check in database.db and temp.db
    const dbs = [
      path.resolve(__dirname, '../../sutramServer/data/projects/database.db'),
      path.resolve(__dirname, '../../sutramServer/data/projects/temp.db')
    ];
    for (const dbPath of dbs) {
      if (fs.existsSync(dbPath)) {
        try {
          const db = new Database(dbPath, { readonly: true });
          const row = db.prepare("SELECT value FROM sys_meta WHERE key = 'vision_profiles'").get();
          if (row && row.value) {
            const profiles = JSON.parse(row.value);
            const active = profiles.find(p => p.isDefault) || profiles[0];
            if (active && active.apiKey) {
              apiKey = active.apiKey;
              console.log(`✅ Loaded API Key from database sys_meta: ${dbPath} (Profile: ${active.label})`);
              break;
            }
          }
          db.close();
        } catch (e) {}
      }
    }
  }

  if (!apiKey) {
    console.error('\n❌ No Gemini API key found.');
    console.error('Usage: node test_live_gemini.js <YOUR_GEMINI_API_KEY>');
    console.error('Or enter it in SutramVision UI modal settings to store in database sys_meta.\n');
    process.exit(1);
  }

  // 2. Load sample handwritten slip image
  const sampleImagePath = '/Users/nastmohaapple/.gemini/antigravity/brain/516d1929-5510-4a07-87c4-41c0c93187ba/.user_uploaded/media_1794759250457_a5b0b205.jpg';
  if (!fs.existsSync(sampleImagePath)) {
    console.error('Sample image not found at:', sampleImagePath);
    process.exit(1);
  }

  const imageBuffer = fs.readFileSync(sampleImagePath);
  const imageBase64 = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  console.log(`📸 Loaded sample image: ${sampleImagePath} (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

  // 3. Instantiate SutramVision Engine
  const vision = new SutramVision();

  console.log('🚀 Calling Gemini API (model: gemini-3.8-flash)...');
  try {
    const result = await vision.extract({
      imageBase64,
      documentType: 'parchi',
      mode: 'normal',
      options: {
        apiKey,
        model: 'gemini-3.8-flash'
      }
    });

    console.log('\n=================== EXTRACTION SUCCESS ===================');
    console.log('Document Type:', result.documentType);
    console.log('Profile Used:', result.profileUsed?.label || 'Direct Key');
    console.log('Token Usage:', result.tokenUsage);
    console.log('Slips Found:', result.data.slipsCount);
    console.log('\nExtracted Normalized Table Rows (Excel-Ready):');
    console.table(result.data.rows.map(r => ({
      Slip: r.slip_no,
      Date: r.date,
      Item: r.item_name,
      SubItem: r.sub_item,
      Specs: r.item_details,
      Qty: r.qty,
      Unit: r.unit,
      Rate: r.rate,
      Amount: r.amount,
      SlipTotal: r.slip_total,
      Discount: r.discount_roundoff
    })));

    console.log('\n✅ Verification PASSED: End-to-end Gemini extraction working seamlessly!');
  } catch (err) {
    console.error('\n❌ Extraction Failed:', err.message);
    if (err.details) console.error('Details:', err.details);
    process.exit(1);
  }
}

main();
