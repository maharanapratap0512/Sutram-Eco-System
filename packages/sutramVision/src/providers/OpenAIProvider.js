'use strict';

const BaseVlmProvider = require('./BaseVlmProvider');

/**
 * OpenAIProvider
 * Native REST integration for OpenAI GPT-4o / GPT-4o mini Vision.
 */
class OpenAIProvider extends BaseVlmProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai';
    this.defaultModel = config.model || 'gpt-4o-mini';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  async testConnection(options = {}) {
    const apiKey = options.apiKey || this.config.apiKey;
    if (!apiKey) {
      return { success: false, message: 'OpenAI API key is missing.' };
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
          message: data?.error?.message || `HTTP ${res.status}: Failed to connect to OpenAI.`
        };
      }

      return {
        success: true,
        provider: 'openai',
        model: this.defaultModel
      };
    } catch (err) {
      return { success: false, message: `Network error connecting to OpenAI: ${err.message}` };
    }
  }

  async extract(params) {
    const apiKey = params.options?.apiKey || this.config.apiKey;
    const model = params.options?.model || this.defaultModel;

    if (!apiKey) {
      throw new Error('[OpenAIProvider] API Key is required.');
    }

    const { mimeType, base64 } = this.stripBase64Header(params.imageBase64);
    const dataUrl = `data:${mimeType || 'image/jpeg'};base64,${base64}`;

    const messages = [];

    if (params.systemPrompt) {
      messages.push({
        role: 'system',
        content: params.systemPrompt + '\nRespond with pure valid JSON only.'
      });
    }

    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: params.userPrompt || 'Extract tabular and handwritten invoice rows as JSON.' },
        {
          type: 'image_url',
          image_url: {
            url: dataUrl,
            detail: params.options?.detail || 'auto' // 'low' or 'high'
          }
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
      const isRateLimit = res.status === 429;
      const err = new Error(data?.error?.message || `OpenAI API error (HTTP ${res.status})`);
      err.status = res.status;
      err.isRateLimit = isRateLimit;
      err.provider = 'openai';
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
        provider: 'openai',
        model,
        promptTokens: usage.prompt_tokens || 0,
        candidatesTokens: usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        durationMs: Date.now() - startTime
      }
    };
  }
}

module.exports = OpenAIProvider;
