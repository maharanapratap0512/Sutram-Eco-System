'use strict';

const BaseVlmProvider = require('./BaseVlmProvider');

/**
 * GroqProvider
 * Groq Cloud Vision API (Llama 3.2 11B/90B Vision) with OpenAI-compatible REST endpoint.
 * Known for extremely fast latency and generous free developer credits.
 */
class GroqProvider extends BaseVlmProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'groq';
    this.defaultModel = config.model || 'llama-3.2-11b-vision-preview';
    this.baseUrl = config.baseUrl || 'https://api.groq.com/openai/v1';
  }

  async testConnection(options = {}) {
    const apiKey = options.apiKey || this.config.apiKey;
    if (!apiKey) {
      return { success: false, message: 'Groq API key is missing.' };
    }

    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const data = await res.json();

      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data?.error?.message || `HTTP ${res.status}: Failed to connect to Groq.`
        };
      }

      return {
        success: true,
        provider: 'groq',
        model: this.defaultModel,
        modelsAvailable: (data.data || []).map(m => m.id).filter(id => id.includes('vision'))
      };
    } catch (err) {
      return { success: false, message: `Network error connecting to Groq: ${err.message}` };
    }
  }

  async extract(params) {
    const apiKey = params.options?.apiKey || this.config.apiKey;
    const model = params.options?.model || this.defaultModel;

    if (!apiKey) {
      throw new Error('[GroqProvider] API Key is required.');
    }

    const { mimeType, base64 } = this.stripBase64Header(params.imageBase64);
    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;

    const messages = [];

    if (params.systemPrompt) {
      messages.push({
        role: 'system',
        content: params.systemPrompt + '\nEnsure output is 100% valid JSON matching the requested structure.'
      });
    }

    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: params.userPrompt || 'Extract tabular and handwritten register rows as JSON.' },
        {
          type: 'image_url',
          image_url: { url: dataUrl }
        }
      ]
    });

    const body = {
      model,
      messages,
      response_format: { type: 'json_object' },
      temperature: params.options?.temperature !== undefined ? params.options.temperature : 0.1
    };

    const startTime = Date.now();
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      const isRateLimit = res.status === 429 || data?.error?.code === 'rate_limit_exceeded';
      const err = new Error(data?.error?.message || `Groq API error (HTTP ${res.status})`);
      err.status = res.status;
      err.isRateLimit = isRateLimit;
      err.provider = 'groq';
      err.details = data?.error;
      throw err;
    }

    const textOutput = data.choices?.[0]?.message?.content || '{}';
    const usage = data.usage || {};

    let parsedJson;
    try {
      parsedJson = JSON.parse(textOutput);
    } catch (e) {
      const cleaned = textOutput.replace(/```(?:json)?/gi, '').trim();
      parsedJson = JSON.parse(cleaned);
    }

    return {
      rawJson: parsedJson,
      tokenUsage: {
        provider: 'groq',
        model,
        promptTokens: usage.prompt_tokens || 0,
        candidatesTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        durationMs: Date.now() - startTime
      }
    };
  }
}

module.exports = GroqProvider;
