'use strict';

const BaseVlmProvider = require('./BaseVlmProvider');

/**
 * OllamaProvider
 * Local, self-hosted Vision-Language Model provider.
 * 100% free, 0 API tokens consumed, works completely offline.
 * Supports Qwen2-VL, Llama 3.2 Vision, BakLLaVA, etc.
 */
class OllamaProvider extends BaseVlmProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'ollama';
    this.defaultModel = config.model || 'qwen2-vl:latest';
    this.baseUrl = config.baseUrl || config.endpoint || 'http://localhost:11434';
  }

  async testConnection(options = {}) {
    const endpoint = options.endpoint || options.baseUrl || this.baseUrl;
    try {
      const res = await fetch(`${endpoint}/api/tags`, { method: 'GET' });
      const data = await res.json();

      if (!res.ok) {
        return { success: false, message: `Ollama returned status ${res.status}` };
      }

      const visionModels = (data.models || [])
        .map(m => m.name)
        .filter(n => n.includes('vl') || n.includes('vision') || n.includes('llava'));

      return {
        success: true,
        provider: 'ollama',
        endpoint,
        modelsFound: data.models?.map(m => m.name) || [],
        recommendedVisionModels: visionModels
      };
    } catch (err) {
      return { success: false, message: `Could not reach Ollama at ${endpoint}. Ensure Ollama is running locally.` };
    }
  }

  async extract(params) {
    const endpoint = params.options?.endpoint || params.options?.baseUrl || this.baseUrl;
    const model = params.options?.model || this.defaultModel;

    const { base64 } = this.stripBase64Header(params.imageBase64);

    const messages = [];

    if (params.systemPrompt) {
      messages.push({
        role: 'system',
        content: params.systemPrompt + '\nOutput ONLY valid raw JSON.'
      });
    }

    messages.push({
      role: 'user',
      content: params.userPrompt || 'Extract tabular and handwritten invoice rows as JSON.',
      images: [base64]
    });

    const body = {
      model,
      messages,
      format: 'json',
      stream: false,
      options: {
        temperature: params.options?.temperature !== undefined ? params.options.temperature : 0.1
      }
    };

    const startTime = Date.now();
    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();

    if (!res.ok) {
      const err = new Error(data?.error || `Ollama API error (HTTP ${res.status})`);
      err.status = res.status;
      err.provider = 'ollama';
      throw err;
    }

    const textOutput = data.message?.content || '{}';

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
        provider: 'ollama',
        model,
        promptTokens: data.prompt_eval_count || 0,
        candidatesTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
        durationMs: Date.now() - startTime
      }
    };
  }
}

module.exports = OllamaProvider;
