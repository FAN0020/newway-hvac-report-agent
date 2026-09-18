const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class OllamaProvider {
  constructor({
    baseUrl = process.env.HVAC_OLLAMA_URL || 'http://127.0.0.1:11434',
    timeoutMs = Number(process.env.HVAC_OLLAMA_TIMEOUT_MS) || 120_000,
    fetcher = globalThis.fetch,
  } = {}) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      throw new TypeError('Ollama URL must be an HTTP loopback address.');
    }
    this.baseUrl = parsed.href.replace(/\/$/, '');
    this.timeoutMs = Math.max(1, timeoutMs);
    this.fetcher = fetcher;
  }

  async health() {
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 3000)) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      return { provider: 'ollama', ready: true, models: (body.models || []).map((item) => item.name).filter(Boolean), error_code: null };
    } catch (error) {
      return {
        provider: 'ollama',
        ready: false,
        models: [],
        error_code: 'OLLAMA_UNAVAILABLE',
        message: `Cannot reach local Ollama at ${this.baseUrl}: ${error.message}`,
      };
    }
  }

  async generateJson({ model, system, prompt, signal }) {
    if (!model) throw Object.assign(new Error('Ollama model is required.'), { code: 'OLLAMA_MODEL_REQUIRED', status: 400 });
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: combinedSignal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: 'json',
          options: { temperature: 0, seed: 42 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('Ollama request was cancelled.'), { code: 'ABORT_ERR', status: 499 });
      if (timeoutSignal.aborted) throw Object.assign(new Error('Ollama request timed out.'), { code: 'OLLAMA_TIMEOUT', status: 504, retryable: true });
      throw Object.assign(new Error(`Cannot reach local Ollama: ${error.message}`), { code: 'OLLAMA_UNAVAILABLE', status: 503, retryable: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Ollama returned HTTP ${response.status}.`), { code: 'OLLAMA_HTTP_ERROR', status: 502, retryable: response.status >= 500 });
    }
    const body = await response.json().catch((error) => {
      throw Object.assign(new Error(`Ollama response is malformed: ${error.message}`), { code: 'OLLAMA_INVALID_RESPONSE', status: 502, retryable: true });
    });
    const content = body.message?.content;
    if (!content) throw Object.assign(new Error('Ollama returned an empty result.'), { code: 'OLLAMA_EMPTY_RESPONSE', status: 502, retryable: true });
    try {
      return { data: JSON.parse(content), provider: 'ollama', model };
    } catch (error) {
      throw Object.assign(new Error(`Ollama did not return valid JSON: ${error.message}`), { code: 'OLLAMA_INVALID_JSON', status: 502, retryable: true });
    }
  }
}
