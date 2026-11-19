import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { AppUpdateService, BackupItem, UpdateResponse } from '../../services/app-update.service';

@Component({
  selector: 'app-app-updater-dialog',
  templateUrl: './app-updater-dialog.component.html',
  styleUrls: ['./app-updater-dialog.component.scss']
})
export class AppUpdaterDialogComponent implements OnInit {
  @Input() visible: boolean = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Input() isDarkMode: boolean = false;

  public activeTab: 'update' | 'backups' = 'update';

  // Update State
  public selectedFile: File | null = null;
  public isApplyingUpdate: boolean = false;
  public updateResult: UpdateResponse | null = null;
  public updateError: string = '';

  // Backups State
  public backups: BackupItem[] = [];
  public isLoadingBackups: boolean = false;
  public isRollingBack: boolean = false;
  public rollbackMessage: string = '';
  public rollbackError: string = '';

  constructor(private updateService: AppUpdateService) {}

  ngOnInit(): void {
    if (this.visible) {
      this.loadBackups();
    }
  }

  public close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  public onTabChange(tab: 'update' | 'backups'): void {
    this.activeTab = tab;
    if (tab === 'backups') {
      this.loadBackups();
    }
  }

  public onFileSelected(event: any): void {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        this.updateError = 'Only valid .zip update files are allowed';
        this.selectedFile = null;
        return;
      }
      this.selectedFile = file;
      this.updateError = '';
      this.updateResult = null;
    }
  }

  public removeSelectedFile(): void {
    this.selectedFile = null;
    this.updateError = '';
  }

  public applyUpdate(): void {
    if (!this.selectedFile) return;

    this.isApplyingUpdate = true;
    this.updateError = '';
    this.updateResult = null;

    this.updateService.applyUpdate(this.selectedFile).subscribe({
      next: (res) => {
        this.isApplyingUpdate = false;
        if (res.success) {
          this.updateResult = res;
          this.selectedFile = null;
          this.loadBackups();
        } else {
          this.updateError = res.error || 'Update failed';
        }
      },
      error: (err) => {
        this.isApplyingUpdate = false;
        this.updateError = err?.error?.error || err.message || 'Error applying update';
      }
    });
  }

  public loadBackups(): void {
    this.isLoadingBackups = true;
    this.rollbackError = '';
    this.updateService.getBackups().subscribe({
      next: (res) => {
        this.isLoadingBackups = false;
        if (res.success && Array.isArray(res.result)) {
          this.backups = res.result;
        }
      },
      error: () => {
        this.isLoadingBackups = false;
        this.rollbackError = 'Failed to load backup snapshots';
      }
    });
  }

  public rollbackToBackup(backup: BackupItem): void {
    const ok = window.confirm(`Restore Sutram to backup "${backup.id}"?\n(Your database folder will remain untouched.)`);
    if (!ok) return;

    this.isRollingBack = true;
    this.rollbackMessage = '';
    this.rollbackError = '';

    this.updateService.rollbackBackup(backup.id).subscribe({
      next: (res) => {
        this.isRollingBack = false;
        if (res.success) {
          this.rollbackMessage = `Successfully restored backup "${backup.id}". Reload the app to apply.`;
          this.loadBackups();
        } else {
          this.rollbackError = res.error || 'Rollback failed';
        }
      },
      error: (err) => {
        this.isRollingBack = false;
        this.rollbackError = err?.error?.error || err.message || 'Rollback error';
      }
    });
  }

  public reloadApp(): void {
    window.location.reload();
  }
}
