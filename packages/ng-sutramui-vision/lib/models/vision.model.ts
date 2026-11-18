export type VlmProviderType = 'gemini' | 'groq' | 'openai' | 'ollama';

export interface VisionProfile {
  id: string;
  label: string;
  provider: VlmProviderType;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  isDefault?: boolean;
  status?: 'online' | 'error' | 'untested';
  statusMessage?: string;
  lastTested?: number;
}

export type VisionMode = 'normal' | 'smart';
export type DocumentScanType = 'parchi' | 'tabular_register' | 'invoice';

export interface VisionColumn {
  key: string;
  header_text: string;
  type?: string;
  matchedTargetCol?: string;
}

export interface VisionTokenUsage {
  provider: string;
  model: string;
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  durationMs: number;
  cached?: boolean;
}

export interface VisionExtractResult {
  success: boolean;
  mode: VisionMode;
  documentType: DocumentScanType;
  imageHash?: string;
  isCached?: boolean;
  profileUsed?: {
    id?: string;
    label?: string;
    provider?: string;
    autoRotated?: boolean;
  };
  tokenUsage?: VisionTokenUsage;
  data: {
    documentType: string;
    detectedTitle?: string;
    columns: VisionColumn[];
    rows: any[];
    header?: any;
    items?: any[];
  };
}

export interface VisionImageItem {
  id: string;
  file?: File;
  name: string;
  previewUrl: string;
  base64Data: string;
  width?: number;
  height?: number;
  originalSizeBytes?: number;
  compressedSizeBytes?: number;
  savingsPercent?: number;
  estimatedTokens?: number;
  rotation: number;
  contrastBoost: boolean;
  status: 'pending' | 'processing' | 'done' | 'error';
  errorMessage?: string;
  extractedResult?: VisionExtractResult;
}

export interface VisionCorrectionItem {
  original_ocr: string;
  corrected: string;
  field?: string;
  table?: string;
}
