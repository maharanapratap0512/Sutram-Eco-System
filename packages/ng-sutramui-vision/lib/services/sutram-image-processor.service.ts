import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SutramImageProcessorService {
  /**
   * Process and optimize an image file or base64 string
   * - Downsamples to maxDimension (saves 75%+ tokens)
   * - Applies rotation
   * - Applies contrast boost for handwriting ink
   */
  public async processImage(
    source: File | string,
    options: {
      maxDimension?: number;
      rotation?: number;
      contrastBoost?: boolean;
      quality?: number;
    } = {}
  ): Promise<{
    base64Data: string;
    width: number;
    height: number;
    originalSizeBytes: number;
    compressedSizeBytes: number;
    savingsPercent: number;
    estimatedTokens: number;
  }> {
    const maxDimension = options.maxDimension || 1536;
    const rotation = (options.rotation || 0) % 360;
    const contrastBoost = !!options.contrastBoost;
    const quality = options.quality || 0.85;

    // Measure original size
    let originalSizeBytes = 0;
    if (source instanceof File) {
      originalSizeBytes = source.size;
    } else if (typeof source === 'string') {
      originalSizeBytes = Math.round((source.length * 3) / 4);
    }

    const img = await this.loadImage(source);

    // Calculate scaled dimensions
    let { width, height } = img;
    if (width > maxDimension || height > maxDimension) {
      if (width > height) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    // Handle rotation on canvas
    const canvas = document.createElement('canvas');
    const isRotated90or270 = rotation === 90 || rotation === 270;
    canvas.width = isRotated90or270 ? height : width;
    canvas.height = isRotated90or270 ? width : height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');

    ctx.save();
    if (rotation === 90) {
      ctx.translate(canvas.width, 0);
      ctx.rotate((90 * Math.PI) / 180);
    } else if (rotation === 180) {
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate((180 * Math.PI) / 180);
    } else if (rotation === 270) {
      ctx.translate(0, canvas.height);
      ctx.rotate((270 * Math.PI) / 180);
    }

    ctx.drawImage(img, 0, 0, width, height);
    ctx.restore();

    // Handwriting ink contrast enhancement if requested
    if (contrastBoost) {
      this.applyInkContrastFilter(ctx, canvas.width, canvas.height);
    }

    const base64Data = canvas.toDataURL('image/jpeg', quality);
    const estimatedTokens = this.estimateGeminiTokens(canvas.width, canvas.height);

    const compressedSizeBytes = Math.round((base64Data.length * 3) / 4);
    const savingsPercent = originalSizeBytes > 0
      ? Math.max(0, Math.round((1 - compressedSizeBytes / originalSizeBytes) * 100))
      : 80;

    return {
      base64Data,
      width: canvas.width,
      height: canvas.height,
      originalSizeBytes,
      compressedSizeBytes,
      savingsPercent,
      estimatedTokens
    };
  }

  /**
   * Format byte count into human-readable format (e.g. 3.4 MB, 142 KB)
   */
  public formatBytes(bytes?: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Apply lightweight grayscale + ink contrast enhancement on canvas
   */
  private applyInkContrastFilter(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const imgData = ctx.getImageData(0, 0, width, height);
    const d = imgData.data;
    // Contrast factor
    const factor = (259 * (35 + 255)) / (255 * (259 - 35));

    for (let i = 0; i < d.length; i += 4) {
      // Grayscale luminance
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Contrast stretch
      const contrasted = factor * (gray - 128) + 128;
      const clamped = Math.min(255, Math.max(0, contrasted));
      d[i] = clamped;
      d[i + 1] = clamped;
      d[i + 2] = clamped;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Estimate Gemini vision tokens (258 tokens per 768x768 tile)
   */
  public estimateGeminiTokens(width: number, height: number): number {
    const tilesX = Math.ceil(width / 768) || 1;
    const tilesY = Math.ceil(height / 768) || 1;
    return Math.min(tilesX * tilesY * 258, 2580);
  }

  private loadImage(source: File | string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = e => reject(new Error('Failed to load image into DOM'));

      if (typeof source === 'string') {
        img.src = source;
      } else {
        const reader = new FileReader();
        reader.onload = e => {
          img.src = e.target?.result as string;
        };
        reader.onerror = e => reject(new Error('Failed to read file as data URL'));
        reader.readAsDataURL(source);
      }
    });
  }
}
