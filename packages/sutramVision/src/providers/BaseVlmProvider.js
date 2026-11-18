'use strict';

/**
 * BaseVlmProvider
 * Abstract interface for Vision-Language Model adapters.
 */
class BaseVlmProvider {
  constructor(config = {}) {
    this.name = 'base';
    this.config = config;
  }

  /**
   * Test connection & API key validity
   * @param {Object} options { apiKey, model, endpoint }
   * @returns {Promise<{ success: boolean, message?: string }>}
   */
  async testConnection(options = {}) {
    throw new Error('testConnection() must be implemented by provider');
  }

  /**
   * Extract visual document data to structured JSON
   * @param {Object} params
   * @param {string} params.imageBase64 - Clean base64 image data (without data URL prefix or with)
   * @param {string} params.mimeType - e.g. 'image/jpeg', 'image/png', 'image/webp'
   * @param {string} params.systemPrompt - Guiding instructions
   * @param {string} params.userPrompt - User prompt instruction
   * @param {Object} [params.jsonSchema] - Optional JSON schema for constrained generation
   * @param {string} [params.mode] - 'normal' (eco) vs 'smart' (adaptive learning)
   * @param {Object} [params.options] - Provider-specific overrides (apiKey, model, temperature)
   * @returns {Promise<{ rawJson: Object, tokenUsage: Object }>}
   */
  async extract(params) {
    throw new Error('extract() must be implemented by provider');
  }

  /**
   * Utility to strip data URI scheme if present
   */
  stripBase64Header(dataUri) {
    if (!dataUri || typeof dataUri !== 'string') return '';
    const match = dataUri.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1], base64: match[2] };
    }
    return { mimeType: 'image/jpeg', base64: dataUri };
  }
}

module.exports = BaseVlmProvider;
