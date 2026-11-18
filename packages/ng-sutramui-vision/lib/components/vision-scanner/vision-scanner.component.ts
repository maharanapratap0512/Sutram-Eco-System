import { Component, Input, Output, EventEmitter, HostListener, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { MessageService } from 'primeng/api';
import { VisionImageItem, VisionMode, DocumentScanType, VisionExtractResult } from '../../models/vision.model';
import { SutramImageProcessorService } from '../../services/sutram-image-processor.service';
import { SutramVisionApiService } from '../../services/sutram-vision-api.service';

@Component({
  selector: 'sutram-vision-scanner',
  templateUrl: './vision-scanner.component.html',
  styleUrls: ['./vision-scanner.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class VisionScannerComponent {
  @Input() isDarkMode: boolean = false;
  @Input() targetColumns: string[] = [];
  @Input() masterVocabulary: string[] = [];
  @Input() activeProfileLabel: string = '';

  @Output() scanCompleted = new EventEmitter<{
    results: VisionExtractResult[];
    images: VisionImageItem[];
  }>();

  images: VisionImageItem[] = [];
  selectedImageId: string | null = null;
  isProcessing: boolean = false;
  progressPercent: number = 0;
  progressStatus: string = '';

  // Mode and DocType controls
  mode: VisionMode = 'normal'; // Normal (Eco) vs Smart (Adaptive)
  documentType: DocumentScanType = 'parchi';

  modeOptions = [
    { label: '⚡ Normal (Eco Mode) — Min Tokens', value: 'normal' },
    { label: '🧠 Smart (Adaptive AI) — Max Accuracy', value: 'smart' }
  ];

  docTypeOptions = [
    { label: '🧾 पर्ची / बिल (Handwritten Slips & Invoices) — Recommended', value: 'parchi' },
    { label: '📋 दैनिक रजिस्टर (Aawak-Jawak / Khatavahi)', value: 'tabular_register' },
    { label: '📑 सामान्य इनवॉइस (Formal Invoice / Bill)', value: 'invoice' }
  ];

  constructor(
    private imageProcessor: SutramImageProcessorService,
    private apiService: SutramVisionApiService,
    private messageService: MessageService,
    private cdr: ChangeDetectorRef
  ) {}

  @HostListener('window:paste', ['$event'])
  handlePaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          this.addFile(file);
        }
      }
    }
  }

  onFileDropped(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer?.files) {
      Array.from(event.dataTransfer.files).forEach(f => this.addFile(f));
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
  }

  onFileInput(event: any): void {
    const files: FileList = event.target.files;
    if (files) {
      Array.from(files).forEach(f => this.addFile(f));
    }
    event.target.value = ''; // Reset input
  }

  async addFile(file: File): Promise<void> {
    const id = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    const initialItem: VisionImageItem = {
      id,
      file,
      name: file.name || `Pasted Image ${this.images.length + 1}`,
      previewUrl: '',
      base64Data: '',
      rotation: 0,
      contrastBoost: false,
      status: 'pending'
    };

    this.images.push(initialItem);
    if (!this.selectedImageId) this.selectedImageId = id;
    this.cdr.markForCheck();

    await this.processImageItem(initialItem);
  }

  async processImageItem(item: VisionImageItem): Promise<void> {
    try {
      const processed = await this.imageProcessor.processImage(item.file || item.base64Data, {
        rotation: item.rotation,
        contrastBoost: item.contrastBoost,
        maxDimension: 1536
      });

      item.base64Data = processed.base64Data;
      item.previewUrl = processed.base64Data;
      item.width = processed.width;
      item.height = processed.height;
      item.originalSizeBytes = processed.originalSizeBytes;
      item.compressedSizeBytes = processed.compressedSizeBytes;
      item.savingsPercent = processed.savingsPercent;
      item.estimatedTokens = processed.estimatedTokens;
      this.cdr.markForCheck();
    } catch (e: any) {
      item.status = 'error';
      item.errorMessage = e.message;
      this.cdr.markForCheck();
    }
  }

  rotateImage(item: VisionImageItem, event: MouseEvent): void {
    event.stopPropagation();
    item.rotation = (item.rotation + 90) % 360;
    this.processImageItem(item);
  }

  toggleContrast(item: VisionImageItem, event: MouseEvent): void {
    event.stopPropagation();
    item.contrastBoost = !item.contrastBoost;
    this.processImageItem(item);
  }

  removeImage(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.images = this.images.filter(img => img.id !== id);
    if (this.selectedImageId === id) {
      this.selectedImageId = this.images[0]?.id || null;
    }
    this.cdr.markForCheck();
  }

  clearAll(): void {
    this.images = [];
    this.selectedImageId = null;
    this.cdr.markForCheck();
  }

  get totalEstimatedTokens(): number {
    return this.images.reduce((acc, img) => acc + (img.estimatedTokens || 258), 0);
  }

  get totalOriginalBytes(): number {
    return this.images.reduce((acc, img) => acc + (img.originalSizeBytes || 0), 0);
  }

  get totalCompressedBytes(): number {
    return this.images.reduce((acc, img) => acc + (img.compressedSizeBytes || 0), 0);
  }

  get totalSavingsPercent(): number {
    if (this.totalOriginalBytes === 0) return 0;
    return Math.max(0, Math.round((1 - this.totalCompressedBytes / this.totalOriginalBytes) * 100));
  }

  formatBytes(bytes?: number): string {
    return this.imageProcessor.formatBytes(bytes);
  }

  async runOcr(): Promise<void> {
    if (this.images.length === 0 || this.isProcessing) return;

    this.isProcessing = true;
    this.progressPercent = 10;
    this.cdr.markForCheck();

    // ── SCENARIO A: True Multi-Image Bulk Merged Mode (All images in 1 API call) ──
    if (this.images.length > 1) {
      this.progressStatus = `Executing Bulk VLM Call: Merging ${this.images.length} images into 1 single request...`;
      this.progressPercent = 35;
      this.images.forEach(img => (img.status = 'processing'));
      this.cdr.markForCheck();

      try {
        const bulkRes = await this.apiService.batchExtract({
          images: this.images.map(img => img.base64Data),
          documentType: this.documentType,
          mode: this.mode,
          bulkMerged: true,
          targetColumns: this.targetColumns,
          masterVocabulary: this.masterVocabulary
        }).toPromise();

        if (bulkRes && bulkRes.success && bulkRes.data?.rows?.length > 0) {
          this.images.forEach(img => {
            img.status = 'done';
            img.extractedResult = bulkRes;
          });
          this.progressPercent = 100;
          this.progressStatus = `Bulk extraction complete! Found ${bulkRes.data.rows.length} rows across ${this.images.length} images.`;
          this.cdr.markForCheck();

          this.messageService.add({
            key: 'visionToast',
            severity: 'success',
            summary: 'Bulk OCR Success',
            detail: `Successfully extracted ${bulkRes.data.rows.length} rows from ${this.images.length} pages!`,
            life: 4000
          });

          this.scanCompleted.emit({ results: [bulkRes], images: this.images });
        } else {
          const warnMsg = bulkRes?.message || 'Bulk extraction found 0 readable rows. Please verify handwriting legibility or rotation.';
          this.images.forEach(img => {
            img.status = 'error';
            img.errorMessage = warnMsg;
          });
          this.messageService.add({
            key: 'visionToast',
            severity: 'warn',
            summary: 'No Rows Extracted',
            detail: warnMsg,
            life: 8000
          });
        }
      } catch (err: any) {
        const errMsg = err?.message || 'Bulk OCR extraction failed';
        const isHighDemand = errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('temporary');
        this.images.forEach(img => {
          img.status = 'error';
          img.errorMessage = errMsg;
        });
        this.messageService.add({
          key: 'visionToast',
          severity: isHighDemand ? 'warn' : 'error',
          summary: isHighDemand ? 'Google AI High Demand' : 'Bulk OCR Failed',
          detail: errMsg,
          life: 9000
        });
      } finally {
        this.isProcessing = false;
        this.cdr.markForCheck();
      }
      return;
    }

    // ── SCENARIO B: Single Image OCR Call ──
    const item = this.images[0];
    item.status = 'processing';
    this.progressStatus = 'Extracting handwritten data...';
    this.progressPercent = 50;
    this.cdr.markForCheck();

    try {
      const res = await this.apiService.extract({
        imageBase64: item.base64Data,
        documentType: this.documentType,
        mode: this.mode,
        targetColumns: this.targetColumns,
        masterVocabulary: this.masterVocabulary
      }).toPromise();

      if (res && res.success && res.data?.rows?.length > 0) {
        item.status = 'done';
        item.extractedResult = res;
        this.progressPercent = 100;
        this.progressStatus = `Extraction successful! Found ${res.data.rows.length} rows.`;

        this.messageService.add({
          key: 'visionToast',
          severity: 'success',
          summary: 'OCR Extraction Success',
          detail: `Extracted ${res.data.rows.length} items from slip!`,
          life: 4000
        });

        this.scanCompleted.emit({ results: [res], images: this.images });
      } else {
        const warnMsg = (res as any)?.message || 'OCR returned 0 readable rows. Please verify handwriting legibility or rotation.';
        item.status = 'error';
        item.errorMessage = warnMsg;
        this.messageService.add({
          key: 'visionToast',
          severity: 'warn',
          summary: 'No Rows Found',
          detail: warnMsg,
          life: 8000
        });
      }
    } catch (err: any) {
      const errMsg = err?.message || 'OCR extraction failed';
      const isHighDemand = errMsg.toLowerCase().includes('high demand') || errMsg.toLowerCase().includes('temporary');
      item.status = 'error';
      item.errorMessage = errMsg;
      this.messageService.add({
        key: 'visionToast',
        severity: isHighDemand ? 'warn' : 'error',
        summary: isHighDemand ? 'Google AI High Demand' : 'OCR Extraction Failed',
        detail: errMsg,
        life: 9000
      });
    } finally {
      this.isProcessing = false;
      this.cdr.markForCheck();
    }
  }
}
