import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { VisionExtractResult, VisionImageItem, VisionProfile } from '../../models/vision.model';
import { SutramVisionProfileService } from '../../services/sutram-vision-profile.service';

@Component({
  selector: 'sutram-vision-dialog',
  templateUrl: './sutram-vision-dialog.component.html',
  styleUrls: ['./sutram-vision-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class SutramVisionDialogComponent implements OnInit {
  @Input() visible: boolean = false;
  @Input() isDarkMode: boolean = false;
  @Input() targetTableName: string = 'default';
  @Input() targetTableColumns: any[] = [];

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() sheetCreated = new EventEmitter<{ title: string; rows: any[]; columns: any[] }>();

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
    if (Array.isArray(this.targetTableColumns)) {
      this.targetSheetColumns = this.targetTableColumns.map(col => ({
        label: col.label || col.display_name || col.field || col.col_name || col,
        value: col.field || col.col_name || col
      }));
    }
  }

  onScanCompleted(data: { results: VisionExtractResult[]; images: VisionImageItem[] }): void {
    if (data.results && data.results.length > 0) {
      const combinedRows: any[] = [];
      const firstResult = data.results[0];

      data.results.forEach(res => {
        if (res.data?.rows) {
          combinedRows.push(...res.data.rows);
        }
      });

      if (combinedRows.length === 0) {
        // Do not switch to empty preview if no rows detected
        return;
      }

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

  onCreateNewSheet(event: { title: string; rows: any[]; columns: any[] }): void {
    this.sheetCreated.emit(event);
    this.close();
  }

  onBackToScanner(): void {
    this.currentView = 'scanner';
    this.cdr.markForCheck();
  }

  openProfiles(): void {
    this.showProfilesModal = true;
  }

  close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.currentView = 'scanner';
    this.cdr.markForCheck();
  }
}
