'use strict';

const GeminiProvider = require('./providers/GeminiProvider');
const GroqProvider = require('./providers/GroqProvider');
const OpenAIProvider = require('./providers/OpenAIProvider');
const OllamaProvider = require('./providers/OllamaProvider');

/**
 * VlmProviderFactory
 * Manages VLM provider instantiation, testing, and multi-profile failover rotation.
 */
class VlmProviderFactory {
  constructor(defaultConfig = {}) {
    this.defaultConfig = defaultConfig;
    this.providers = {
      gemini: new GeminiProvider(defaultConfig.gemini || {}),
      groq: new GroqProvider(defaultConfig.groq || {}),
      openai: new OpenAIProvider(defaultConfig.openai || {}),
      ollama: new OllamaProvider(defaultConfig.ollama || {})
    };
  }

  /**
   * Get provider instance by name
   * @param {string} name
   * @returns {BaseVlmProvider}
   */
  getProvider(name = 'gemini') {
    const key = (name || 'gemini').toLowerCase();
    const provider = this.providers[key];
    if (!provider) {
      throw new Error(`[VlmProviderFactory] Unsupported VLM provider: "${name}". Supported: gemini, groq, openai, ollama`);
    }
    return provider;
  }

  /**
   * Execute extraction with automatic profile failover on rate limits (HTTP 429)
   * @param {Object} params - Extraction parameters
   * @param {Array<Object>} profiles - List of candidate profiles [{ provider, apiKey, model, label }]
   * @param {boolean} [autoRotate=true] - Whether to failover on 429
   */
  async executeWithFailover(params, profiles = [], autoRotate = true) {
    if (!profiles || profiles.length === 0) {
      // Fallback to default configured provider
      const provider = this.getProvider(params.options?.provider || 'gemini');
      return await provider.extract(params);
    }

    let lastError = null;
    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const provider = this.getProvider(profile.provider || 'gemini');

      const mergedParams = {
        ...params,
        options: {
          ...params.options,
          apiKey: profile.apiKey,
          model: profile.model,
          endpoint: profile.endpoint,
          temperature: profile.temperature
        }
      };

      try {
        const result = await provider.extract(mergedParams);
        result.profileUsed = {
          index: i,
          id: profile.id,
          label: profile.label || `Profile ${i + 1}`,
          provider: profile.provider,
          autoRotated: i > 0
        };
        return result;
      } catch (err) {
        lastError = err;
        const isRateLimit = err.isRateLimit || err.status === 429 || (err.message && err.message.includes('429'));
        if (autoRotate && isRateLimit && i < profiles.length - 1) {
          console.warn(`⚠️ [sutramVision] Rate limit hit on profile "${profile.label || profile.provider}". Auto-rotating to backup profile ${i + 2}...`);
          continue; // Try next profile in the rotation
        }
        // If not rate limit or no more profiles, throw error
        throw err;
      }
    }

    throw lastError || new Error('All configured API profiles failed.');
  }
}

module.exports = VlmProviderFactory;
