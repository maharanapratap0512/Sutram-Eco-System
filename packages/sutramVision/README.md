# sutramvision (`@sutram/vision`)

Visual Document & Handwriting OCR AI Engine for the **Sutram Eco-System**.
Converts handwritten invoices, delivery chalans, and Aawak-Jawak (inward/outward) tabular registers into structured JSON objects.

---

## ⚡ Highlights

- **Multi-VLM Providers**: Google AI Studio (Gemini 2.0 / 1.5 Flash), Groq Cloud (Llama 3.2 Vision), OpenAI (GPT-4o / mini), Local Ollama (offline).
- **Dual Operational Modes**:
  - `normal` (Eco Mode ⚡): Minimal prompts, zero training data tokens burned, ultra-lean JSON schema.
  - `smart` (Adaptive AI 🧠): Injects active correction memory, master catalog grounding, and arithmetic self-validation.
- **Multi-API Profile Vault & Auto-Rotator**: Rotate across multiple free Google/Groq accounts automatically on HTTP 429 rate limit.
- **Handwriting Heuristics**: Automatic ditto-mark (`"`, `-do-`) forward resolution, Devanagari numerals, and vernacular abbreviations.
- **Universal Design**: Zero hardcoded domain terms. Works with any SQLite or MySQL database.

---

## 🚀 Quick Start (Express Server)

```javascript
const express = require('express');
const { SutramVision } = require('sutramvision');

const app = express();
app.use(express.json({ limit: '50mb' }));

const vision = new SutramVision({
  defaultProvider: 'gemini',
  enableCache: true
});

// Mount router
app.use('/_sutram/vision', vision.router());

app.listen(3000, () => console.log('SutramVision ready on :3000'));
```

---

## 📡 REST API Endpoints

- `POST /_sutram/vision/test-connection` — Test API key connectivity.
- `POST /_sutram/vision/extract` — Extract structured data from single image.
- `POST /_sutram/vision/batch-extract` — Sequential multi-image bulk processing.
- `POST /_sutram/vision/corrections/save` — Save user correction pair for continuous active learning.
- `GET /_sutram/vision/corrections` — List learned corrections.
