import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { VisionExtractResult, VisionImageItem, VisionProfile } from '../../models/vision.model';
import { SutramVisionProfileService } from '../../services/sutram-vision-profile.service';

@Component({
  selector: 'sutram-vision-workbench',
  templateUrl: './sutram-vision-workbench.component.html',
  styleUrls: ['./sutram-vision-workbench.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class SutramVisionWorkbenchComponent implements OnInit {
  @Input() isDarkMode: boolean = false;
  @Input() tableName: string = 'default';
  @Input() tableTitle: string = 'Active Table';
  @Input() currentTableColumns: any[] = []; // Target table headers from sutram-excel-studio

  @Output() rowsExtracted = new EventEmitter<any[]>();
  @Output() close = new EventEmitter<void>();

  currentView: 'scanner' | 'preview' = 'scanner';
  showProfilesModal: boolean = false;

  activeProfile: VisionProfile | null = null;
  activeExtractResult: VisionExtractResult | null = null;
  activePreviewImage: string = '';

  targetSheetColumns: { label: string; value: string }[] = [];

  constructor(
    public profileService: SutramVisionProfileService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.activeProfile = this.profileService.getActiveProfile();
    this.buildTargetColumns();

    this.profileService.profiles$.subscribe(profs => {
      this.activeProfile = profs.find(p => p.isDefault) || profs[0] || null;
      this.cdr.markForCheck();
    });
  }

  buildTargetColumns(): void {
    if (Array.isArray(this.currentTableColumns)) {
      this.targetSheetColumns = this.currentTableColumns.map(col => ({
        label: col.label || col.display_name || col.field || col.col_name || col,
        value: col.field || col.col_name || col
      }));
    }
  }

  onScanCompleted(data: { results: VisionExtractResult[]; images: VisionImageItem[] }): void {
    if (data.results && data.results.length > 0) {
      // If single image or multiple images, focus on first and combine rows
      const combinedRows: any[] = [];
      const firstResult = data.results[0];

      data.results.forEach(res => {
        if (res.data?.rows) {
          combinedRows.push(...res.data.rows);
        }
      });

      this.activeExtractResult = {
        ...firstResult,
        data: {
          ...firstResult.data,
          rows: combinedRows
        }
      };

      this.activePreviewImage = data.images[0]?.previewUrl || '';
      this.currentView = 'preview';
      this.cdr.markForCheck();
    }
  }

  onInsertRows(rows: any[]): void {
    this.rowsExtracted.emit(rows);
    this.currentView = 'scanner';
    this.cdr.markForCheck();
  }

  onBackToScanner(): void {
    this.currentView = 'scanner';
    this.cdr.markForCheck();
  }

  openProfiles(): void {
    this.showProfilesModal = true;
  }

  onProfilesUpdated(): void {
    this.activeProfile = this.profileService.getActiveProfile();
    this.cdr.markForCheck();
  }
}
