import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { VisionColumn, VisionCorrectionItem, VisionExtractResult } from '../../models/vision.model';
import { SutramVisionApiService } from '../../services/sutram-vision-api.service';

@Component({
  selector: 'sutram-vision-preview-grid',
  templateUrl: './vision-preview-grid.component.html',
  styleUrls: ['./vision-preview-grid.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class VisionPreviewGridComponent implements OnInit {
  @Input() isDarkMode: boolean = false;
  @Input() previewImageUrl: string = '';
  @Input() extractResult: VisionExtractResult | null = null;
  @Input() targetSheetColumns: { label: string; value: string }[] = [];
  @Input() tableName: string = 'default';

  @Output() createNewSheet = new EventEmitter<{ title: string; rows: any[]; columns: any[] }>();
  @Output() closePreview = new EventEmitter<void>();

  columns: VisionColumn[] = [];
  rows: any[] = [];
  columnMappings: { [extractedKey: string]: string } = {};

  // Active Correction State
  activeCorrection: {
    visible: boolean;
    original: string;
    corrected: string;
    field: string;
  } = { visible: false, original: '', corrected: '', field: '' };

  constructor(
    private apiService: SutramVisionApiService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    if (this.extractResult?.data) {
      this.initData(this.extractResult);
    }
  }

  initData(res: VisionExtractResult): void {
    const data = res.data;
    this.columns = (data.columns || []).map(c => ({
      key: c.key,
      header_text: c.header_text || c.key,
      type: c.type || 'text'
    }));

    this.rows = Array.isArray(data.rows) ? JSON.parse(JSON.stringify(data.rows)) : [];
    this.autoMatchColumns();
    this.cdr.markForCheck();
  }

  autoMatchColumns(): void {
    if (!this.targetSheetColumns || this.targetSheetColumns.length === 0) {
      this.columns.forEach(col => {
        this.columnMappings[col.key] = col.key;
      });
      return;
    }

    this.columns.forEach(col => {
      const colText = (col.header_text || col.key).toLowerCase().replace(/[^a-zA-Z0-9\u0900-\u097F]/g, '');

      const match = this.targetSheetColumns.find(tc => {
        const targetLabel = tc.label.toLowerCase().replace(/[^a-zA-Z0-9\u0900-\u097F]/g, '');
        const targetVal = tc.value.toLowerCase();
        return (
          colText === targetLabel ||
          colText === targetVal ||
          targetLabel.includes(colText) ||
          colText.includes(targetLabel)
        );
      });

      if (match) {
        this.columnMappings[col.key] = match.value;
      } else {
        this.columnMappings[col.key] = col.key;
      }
    });
  }

  onCellEdited(row: any, key: string, originalVal: any): void {
    const newVal = row[key];
    if (originalVal && newVal && originalVal !== newVal) {
      this.activeCorrection = {
        visible: true,
        original: String(originalVal),
        corrected: String(newVal),
        field: key
      };
      this.cdr.markForCheck();
    }
  }

  saveCorrection(): void {
    if (!this.activeCorrection.original || !this.activeCorrection.corrected) return;

    this.apiService.saveCorrection({
      original_ocr: this.activeCorrection.original,
      corrected: this.activeCorrection.corrected,
      field: this.activeCorrection.field,
      table: this.tableName
    }).subscribe({
      next: () => {
        this.activeCorrection.visible = false;
        this.cdr.markForCheck();
      },
      error: err => {
        console.error('Failed to save correction:', err);
        this.activeCorrection.visible = false;
        this.cdr.markForCheck();
      }
    });
  }

  deleteRow(index: number): void {
    this.rows.splice(index, 1);
    this.cdr.markForCheck();
  }

  onConfirmCreateSheet(): void {
    const title = this.extractResult?.data?.detectedTitle || 'OCR Scan';

    // Map column names
    const mappedCols = this.columns.map(c => ({
      key: this.columnMappings[c.key] || c.key,
      header_text: c.header_text || c.key,
      type: c.type || 'string'
    }));

    // Transform rows
    const transformedRows = this.rows.map(row => {
      const newRow: any = {};
      for (const [extractedKey, targetKey] of Object.entries(this.columnMappings)) {
        if (targetKey && row[extractedKey] !== undefined) {
          newRow[targetKey] = row[extractedKey];
        }
      }
      return newRow;
    });

    this.createNewSheet.emit({
      title,
      rows: transformedRows,
      columns: mappedCols
    });
  }
}
