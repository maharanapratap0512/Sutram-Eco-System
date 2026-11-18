'use strict';

const VlmProviderFactory = require('./VlmProviderFactory');
const CorrectionMemory = require('./CorrectionMemory');
const DocumentParser = require('./DocumentParser');
const RegisterTabularPrompt = require('./prompts/RegisterTabularPrompt');
const InvoiceVoucherPrompt = require('./prompts/InvoiceVoucherPrompt');
const ParchiPrompt = require('./prompts/ParchiPrompt');
const ImageOptimizer = require('./ImageOptimizer');

/**
 * SutramVision
 * Master Engine for visual document & handwriting OCR within Sutram Eco-System.
 */
class SutramVision {
  constructor(options = {}) {
    this.options = {
      defaultProvider: options.defaultProvider || 'gemini',
      enableCache: options.enableCache === true, // Default to FALSE to ensure live fresh extractions
      ...options
    };

    this.factory = new VlmProviderFactory(options.providers || {});
    this.memory = new CorrectionMemory(options.memory || {});
    this.cache = new Map(); // SHA-256 cache
  }

  /**
   * Test connection to a VLM provider
   */
  async testConnection(providerName = 'gemini', options = {}) {
    const provider = this.factory.getProvider(providerName);
    return await provider.testConnection(options);
  }

  /**
   * Extract visual data from an image
   * @param {Object} params
   * @param {string} params.imageBase64
   * @param {string} [params.documentType='parchi'] - 'parchi' | 'tabular_register' | 'invoice'
   * @param {string} [params.mode='normal'] - 'normal' (eco token saver) vs 'smart' (adaptive learning)
   * @param {Array<string>} [params.targetColumns]
   * @param {Array<string>} [params.masterVocabulary]
   * @param {Array<Object>} [params.apiProfiles] - Multi-key profiles for auto-rotation
   * @param {boolean} [params.autoRotate=true]
   */
  async extract(params = {}) {
    const {
      imageBase64,
      documentType = 'parchi',
      mode = 'normal',
      targetColumns = [],
      masterVocabulary = [],
      apiProfiles = [],
      autoRotate = true,
      options = {}
    } = params;

    if (!imageBase64) {
      throw new Error('[SutramVision] imageBase64 is required.');
    }

    // 1. Check SHA-256 cache if enabled
    const imageHash = ImageOptimizer.hash(imageBase64);
    const cacheKey = `${imageHash}:${documentType}:${mode}:${options.startSlipNumber || 1}`;
    if (this.options.enableCache && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return {
        ...cached,
        isCached: true,
        tokenUsage: { ...cached.tokenUsage, totalTokens: 0, cached: true }
      };
    }

    // 2. Retrieve past corrections for Smart mode
    const corrections = mode === 'smart' ? this.memory.getCorrections(options.table || 'default', 10) : [];

    // 3. Build Prompt & JSON Schema according to document type & mode
    let promptConfig;
    if (documentType === 'parchi') {
      promptConfig = ParchiPrompt.buildPrompt({
        mode,
        masterVocabulary,
        corrections
      });
    } else if (documentType === 'invoice') {
      promptConfig = InvoiceVoucherPrompt.buildPrompt({
        mode,
        targetColumns,
        masterVocabulary,
        corrections
      });
    } else {
      promptConfig = RegisterTabularPrompt.buildPrompt({
        mode,
        targetColumns,
        masterVocabulary,
        corrections
      });
    }

    // 4. Execute extraction with Multi-Profile Failover Rotator
    const extractionResult = await this.factory.executeWithFailover(
      {
        imageBase64,
        systemPrompt: promptConfig.systemPrompt,
        userPrompt: promptConfig.userPrompt,
        jsonSchema: promptConfig.jsonSchema,
        mode,
        options
      },
      apiProfiles,
      autoRotate
    );

    // 5. Normalize, auto-derive missing rates, handle multi-slips & calculate last-row totals
    let normalized;
    if (documentType === 'parchi') {
      normalized = DocumentParser.normalizeParchi(extractionResult.rawJson, options);
    } else if (documentType === 'invoice') {
      normalized = DocumentParser.normalizeInvoice(extractionResult.rawJson, options);
    } else {
      normalized = DocumentParser.normalizeTabularRegister(extractionResult.rawJson, options);
    }

    // Auto-Recovery: If schema-constrained mode returned 0 rows, retry once in resilient free-form JSON mode
    if ((!normalized.rows || normalized.rows.length === 0) && promptConfig.jsonSchema) {
      console.warn('⚠️ [SutramVision] Schema-constrained extraction returned 0 rows. Retrying in resilient free-form JSON mode...');
      try {
        const retryResult = await this.factory.executeWithFailover(
          {
            imageBase64,
            systemPrompt: promptConfig.systemPrompt + '\n\nIMPORTANT: Return valid JSON matching the format example with all transcribed items.',
            userPrompt: promptConfig.userPrompt,
            jsonSchema: null,
            mode,
            options
          },
          apiProfiles,
          autoRotate
        );
        if (retryResult && retryResult.rawJson) {
          if (documentType === 'parchi') {
            normalized = DocumentParser.normalizeParchi(retryResult.rawJson, options);
          } else if (documentType === 'invoice') {
            normalized = DocumentParser.normalizeInvoice(retryResult.rawJson, options);
          } else {
            normalized = DocumentParser.normalizeTabularRegister(retryResult.rawJson, options);
          }
          if (normalized.rows && normalized.rows.length > 0) {
            extractionResult.rawJson = retryResult.rawJson;
            extractionResult.tokenUsage = retryResult.tokenUsage;
          }
        }
      } catch (retryErr) {
        console.warn('⚠️ [SutramVision] Free-form retry notice:', retryErr.message);
      }
    }

    if (!normalized.rows || normalized.rows.length === 0) {
      const rawPreview = JSON.stringify(extractionResult.rawJson || {}).slice(0, 300);
      throw new Error(`[SutramVision] No rows could be extracted from image. VLM Output: ${rawPreview}`);
    }

    const finalResponse = {
      success: true,
      mode,
      documentType,
      imageHash,
      profileUsed: extractionResult.profileUsed,
      tokenUsage: extractionResult.tokenUsage,
      data: normalized
    };

    // Store in cache only if rows were actually found
    if (this.options.enableCache && finalResponse.data?.rows?.length > 0) {
      this.cache.set(cacheKey, finalResponse);
    }

    return finalResponse;
  }

  /**
   * Process multiple images in ONE single VLM API call (Multi-Image Bulk Merging)
   * Drastically saves prompt tokens and consumes only 1 request against RPM quotas.
   * All slips across all images are consolidated into a single continuous sequence.
   * @param {Array<string>} images - Array of base64 image strings
   * @param {Object} params
   */
  async bulkExtractMerged(images = [], params = {}) {
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('[SutramVision] bulkExtractMerged requires non-empty array of images.');
    }

    const {
      documentType = 'parchi',
      mode = 'normal',
      targetColumns = [],
      masterVocabulary = [],
      apiProfiles = [],
      autoRotate = true,
      options = {}
    } = params;

    const corrections = mode === 'smart' ? this.memory.getCorrections(options.table || 'default', 10) : [];

    let promptConfig;
    if (documentType === 'parchi') {
      promptConfig = ParchiPrompt.buildPrompt({ mode, masterVocabulary, corrections });
      promptConfig.userPrompt = `Transcribe all handwritten slips across all ${images.length} images into a single continuous list of slips (Slip 1, Slip 2, ...). Extract item specs, units, rates, amounts, less deductions, and totals for each slip.`;
    } else if (documentType === 'invoice') {
      promptConfig = InvoiceVoucherPrompt.buildPrompt({ mode, targetColumns, masterVocabulary, corrections });
      promptConfig.userPrompt = `Transcribe all handwritten invoices and receipts across all ${images.length} images into structured line items.`;
    } else {
      promptConfig = RegisterTabularPrompt.buildPrompt({ mode, targetColumns, masterVocabulary, corrections });
      promptConfig.userPrompt = `Transcribe all register pages across all ${images.length} images into continuous tabular rows matching the top headers.`;
    }

    const extractionResult = await this.factory.executeWithFailover(
      {
        images,
        systemPrompt: promptConfig.systemPrompt,
        userPrompt: promptConfig.userPrompt,
        jsonSchema: promptConfig.jsonSchema,
        mode,
        options
      },
      apiProfiles,
      autoRotate
    );

    let normalized;
    if (documentType === 'parchi') {
      normalized = DocumentParser.normalizeParchi(extractionResult.rawJson, options);
    } else if (documentType === 'invoice') {
      normalized = DocumentParser.normalizeInvoice(extractionResult.rawJson, options);
    } else {
      normalized = DocumentParser.normalizeTabularRegister(extractionResult.rawJson, options);
    }

    if (!normalized.rows || normalized.rows.length === 0) {
      const rawPreview = JSON.stringify(extractionResult.rawJson || {}).slice(0, 300);
      throw new Error(`[SutramVision] Bulk VLM extraction found 0 rows across ${images.length} images. Raw: ${rawPreview}`);
    }

    return {
      success: true,
      isBulkMerged: true,
      imagesCount: images.length,
      mode,
      documentType,
      profileUsed: extractionResult.profileUsed,
      tokenUsage: extractionResult.tokenUsage,
      data: normalized
    };
  }

  /**
   * Process multiple images sequentially with rate pacing and continuous slip numbering
   * @param {Array<string>} images - Array of base64 image strings
   * @param {Object} baseParams
   * @param {Function} [onProgress] - Callback for each completed image
   */
  async batchExtract(images = [], baseParams = {}, onProgress = null) {
    if (!Array.isArray(images) || images.length === 0) {
      throw new Error('[SutramVision] batchExtract requires non-empty array of images.');
    }

    const results = [];
    let totalTokens = 0;
    let runningSlipCount = 0;
    const combinedAllRows = [];
    let combinedColumns = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      try {
        const res = await this.extract({
          ...baseParams,
          imageBase64: img,
          options: {
            ...baseParams.options,
            startSlipNumber: runningSlipCount + 1
          }
        });

        results.push({ index: i, success: true, result: res });
        totalTokens += res.tokenUsage?.totalTokens || 0;

        if (res.data?.rows) {
          combinedAllRows.push(...res.data.rows);
        }
        if (res.data?.columns && combinedColumns.length === 0) {
          combinedColumns = res.data.columns;
        }

        runningSlipCount += res.data?.slipsCount || 1;
      } catch (err) {
        results.push({ index: i, success: false, error: err.message, status: err.status });
      }

      if (typeof onProgress === 'function') {
        onProgress({ current: i + 1, total: images.length, results });
      }

      // Small 300ms pause between bulk requests to respect free-tier RPM
      if (i < images.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    return {
      success: true,
      totalImages: images.length,
      successCount: results.filter(r => r.success).length,
      failedCount: results.filter(r => !r.success).length,
      totalSlips: runningSlipCount,
      totalTokens,
      combinedData: {
        documentType: baseParams.documentType || 'parchi',
        detectedTitle: `पर्ची हिसाब (${runningSlipCount} Slips)`,
        columns: combinedColumns,
        rows: combinedAllRows
      },
      results
    };
  }

  /**
   * Get an Express router with pre-mounted REST endpoints
   */
  router() {
    const VisionRouter = require('./VisionRouter');
    return VisionRouter.create(this);
  }
}

module.exports = SutramVision;
