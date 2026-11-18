'use strict';

const BaseVlmProvider = require('./BaseVlmProvider');

/**
 * GeminiProvider
 * Direct REST implementation for Google AI Studio (Gemini 2.0 / 1.5 Flash).
 * Zero heavy SDK dependencies. Leverages Node 18+ native fetch.
 */
class GeminiProvider extends BaseVlmProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'gemini';
    this.defaultModel = config.model || 'gemini-3.8-flash';
    this.baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async testConnection(options = {}) {
    const apiKey = options.apiKey || this.config.apiKey;
    let model = options.model || this.defaultModel;
    if (model === 'gemini-2.0-flash') model = 'gemini-3.8-flash';

    if (!apiKey) {
      return { success: false, message: 'Google Gemini API key is missing.' };
    }

    try {
      const url = `${this.baseUrl}/models/${model}?key=${apiKey}`;
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json();

      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data?.error?.message || `HTTP ${res.status}: Failed to connect to Gemini API.`
        };
      }

      return {
        success: true,
        provider: 'gemini',
        model: data.name || model,
        displayName: data.displayName || model,
        supportedGenerationMethods: data.supportedGenerationMethods || []
      };
    } catch (err) {
      return { success: false, message: `Network error connecting to Gemini: ${err.message}` };
    }
  }

  async extract(params) {
    const apiKey = params.options?.apiKey || this.config.apiKey;
    let model = params.options?.model || this.defaultModel;
    if (model === 'gemini-2.0-flash') model = 'gemini-3.8-flash';

    if (!apiKey) {
      throw new Error('[GeminiProvider] API Key is required.');
    }

    // Build multi-modal parts: supports single image or bulk array of images
    const userParts = [
      { text: params.userPrompt || 'Extract all tabular rows and key-value fields from this image as structured JSON.' }
    ];

    const imageList = Array.isArray(params.images) && params.images.length > 0
      ? params.images
      : (params.imageBase64 ? [params.imageBase64] : []);

    if (imageList.length === 0) {
      throw new Error('[GeminiProvider] At least one image is required.');
    }

    for (let i = 0; i < imageList.length; i++) {
      const { mimeType, base64 } = this.stripBase64Header(imageList[i]);
      if (imageList.length > 1) {
        userParts.push({ text: `=== DOCUMENT / PAGE ${i + 1} OF ${imageList.length} ===` });
      }
      userParts.push({
        inlineData: {
          mimeType: mimeType || 'image/jpeg',
          data: base64
        }
      });
    }

    const contents = [
      {
        role: 'user',
        parts: userParts
      }
    ];

    const generationConfig = {
      responseMimeType: 'application/json',
      temperature: params.options?.temperature !== undefined ? params.options.temperature : 0.1
    };

    if (params.jsonSchema && typeof params.jsonSchema === 'object') {
      const cleaned = this.cleanSchemaForGemini(params.jsonSchema);
      if (cleaned && Object.keys(cleaned).length > 0) {
        generationConfig.responseSchema = cleaned;
      }
    }

    const body = {
      contents,
      generationConfig
    };

    if (params.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: params.systemPrompt }]
      };
    }

    const maxRetries = 3;
    let attempt = 0;
    let response;
    let data;
    let activeModel = model;
    const startTime = Date.now();

    while (attempt < maxRetries) {
      attempt++;
      // If previous attempts hit high demand on 3.8-flash, switch to high-capacity gemini-1.5-flash on 3rd attempt
      if (attempt === 3 && activeModel === 'gemini-3.8-flash') {
        console.warn('⚠️ [GeminiProvider] High demand spike on 3.8-flash. Switching to high-throughput gemini-1.5-flash fallback...');
        activeModel = 'gemini-1.5-flash';
      }

      const url = `${this.baseUrl}/models/${activeModel}:generateContent?key=${apiKey}`;

      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      data = await response.json();

      // Resilient fallback: If Gemini rejects responseSchema (e.g. unsupported keyword), retry immediately without responseSchema
      if (!response.ok && body.generationConfig?.responseSchema) {
        const errMsg = data?.error?.message || '';
        if (errMsg.includes('response_schema') || errMsg.includes('Unknown name') || errMsg.includes('additionalProperties')) {
          console.warn('⚠️ [GeminiProvider] Schema rejected by Gemini API. Retrying without responseSchema with JSON mode:', errMsg);
          delete body.generationConfig.responseSchema;
          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          data = await response.json();
        }
      }

      if (response.ok) {
        break; // Success!
      }

      const errMsg = (data?.error?.message || '').toLowerCase();
      const isHighDemand = response.status === 503 || response.status === 429 ||
        errMsg.includes('high demand') ||
        errMsg.includes('overloaded') ||
        errMsg.includes('temporary') ||
        data?.error?.status === 'RESOURCE_EXHAUSTED' ||
        data?.error?.status === 'UNAVAILABLE';

      if (isHighDemand && attempt < maxRetries) {
        const waitMs = attempt * 2000; // 2000ms, 4000ms
        console.warn(`⏳ [GeminiProvider] High demand spike (HTTP ${response.status}). Waiting ${waitMs}ms before auto-retry (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      break;
    }

    if (!response.ok) {
      const isRateLimit = response.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED';
      const rawMsg = data?.error?.message || `Gemini API error (HTTP ${response.status})`;
      let userFriendlyMsg = rawMsg;
      if (rawMsg.toLowerCase().includes('high demand') || rawMsg.toLowerCase().includes('temporary')) {
        userFriendlyMsg = 'Google Gemini model is experiencing temporary high demand spikes. Please wait a few seconds and try again.';
      }
      const err = new Error(userFriendlyMsg);
      err.status = response.status;
      err.isRateLimit = isRateLimit;
      err.provider = 'gemini';
      err.details = data?.error;
      throw err;
    }

    if (!data.candidates || data.candidates.length === 0) {
      const blockReason = data.promptFeedback?.blockReason || 'No candidate response returned from Gemini';
      throw new Error(`[GeminiProvider] Gemini did not generate a response (${blockReason}).`);
    }

    const candidate = data.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
      throw new Error(`[GeminiProvider] Gemini generation stopped unexpectedly (${candidate.finishReason}).`);
    }

    const textPart = candidate?.content?.parts?.[0]?.text;
    if (!textPart || !textPart.trim()) {
      throw new Error(`[GeminiProvider] Gemini response candidate text was empty. finishReason: ${candidate?.finishReason}`);
    }

    const usageMetadata = data.usageMetadata || {};

    let parsedJson;
    try {
      parsedJson = JSON.parse(textPart);
    } catch (e) {
      // Clean possible markdown code fences if responseMimeType wasn't fully respected
      const cleaned = textPart.replace(/```(?:json)?/gi, '').trim();
      try {
        parsedJson = JSON.parse(cleaned);
      } catch (e2) {
        const jsonMatch = textPart.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
        if (jsonMatch) {
          parsedJson = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`[GeminiProvider] Could not parse JSON from Gemini: ${e.message}\nText: ${textPart.slice(0, 300)}`);
        }
      }
    }

    // Append to debug log
    try {
      const fs = require('fs');
      const path = require('path');
      const logLine = `[${new Date().toISOString()}] Model: ${model} | Tokens: ${usageMetadata.totalTokens || 0} | RawKeys: ${Object.keys(parsedJson || {}).join(',')}\n`;
      fs.appendFileSync(path.resolve(__dirname, '../../vision_debug.log'), logLine);
    } catch (e) {}

    return {
      rawJson: parsedJson,
      tokenUsage: {
        provider: 'gemini',
        model,
        promptTokens: usageMetadata.promptTokenCount || 0,
        candidatesTokens: usageMetadata.candidatesTokenCount || 0,
        totalTokens: usageMetadata.totalTokens || 0,
        imagesProcessed: imageList.length,
        durationMs: Date.now() - startTime
      }
    };
  }

  /**
   * Cleans JSON Schema to conform strictly to Google Gemini OpenAPI 3.0 subset.
   * Whitelist approach: only retains valid OpenAPI 3.0 schema attributes accepted by Gemini.
   */
  cleanSchemaForGemini(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanSchemaForGemini(item));
    }

    const ALLOWED_KEYS = new Set([
      'type',
      'format',
      'description',
      'nullable',
      'enum',
      'maxItems',
      'minItems',
      'properties',
      'required',
      'items'
    ]);

    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
      if (!ALLOWED_KEYS.has(key)) {
        continue;
      }
      clean[key] = this.cleanSchemaForGemini(value);
    }
    return clean;
  }
}

module.exports = GeminiProvider;
