'use strict';

const crypto = require('crypto');

/**
 * ImageOptimizer
 * Utilities for image hashing, token estimation, and payload validation.
 */
class ImageOptimizer {
  /**
   * Compute SHA-256 hash of an image buffer or base64 string
   * @param {string|Buffer} imageData
   * @returns {string} Hex hash
   */
  static hash(imageData) {
    if (!imageData) return '';
    const hash = crypto.createHash('sha256');
    if (typeof imageData === 'string') {
      // Remove data URL prefix if present
      const clean = imageData.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
      hash.update(clean);
    } else {
      hash.update(imageData);
    }
    return hash.digest('hex');
  }

  /**
   * Estimate tokens consumed by an image for a specific provider
   * @param {number} width
   * @param {number} height
   * @param {string} provider - 'gemini' | 'openai' | 'groq' | 'ollama'
   * @param {string} [detail='auto']
   * @returns {number} Estimated tokens
   */
  static estimateImageTokens(width = 1500, height = 1000, provider = 'gemini', detail = 'auto') {
    if (provider === 'gemini') {
      // Gemini: Images are tiled into 768x768 patches (~258 tokens per patch)
      const tilesX = Math.ceil(width / 768) || 1;
      const tilesY = Math.ceil(height / 768) || 1;
      return Math.min(tilesX * tilesY * 258, 3000);
    }

    if (provider === 'openai') {
      if (detail === 'low') return 85;
      // High detail: scale to fit within 2048x2048, then shortest side to 768
      const tilesX = Math.ceil(width / 512) || 1;
      const tilesY = Math.ceil(height / 512) || 1;
      return 85 + (tilesX * tilesY * 170);
    }

    // Default estimate for Groq / Ollama
    return 600;
  }

  /**
   * Get recommended max dimensions for optimal handwriting legibility vs token savings
   */
  static getRecommendedBounds() {
    return {
      maxDimension: 1536,
      minDimension: 800,
      targetQuality: 0.85,
      preferredFormat: 'image/jpeg'
    };
  }
}

module.exports = ImageOptimizer;
