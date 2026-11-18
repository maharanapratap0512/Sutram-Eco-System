import { Component, Input, Output, EventEmitter, ChangeDetectorRef, OnChanges, SimpleChanges } from '@angular/core';
import { ProjectContextService } from '../../services/project-context.service';
import { ProjectItem, DbInspectionReport } from '../../models/project.model';

@Component({
  selector: 'app-create-project-modal',
  templateUrl: './create-project-modal.component.html',
  styleUrls: ['./create-project-modal.component.scss']
})
export class CreateProjectModalComponent implements OnChanges {
  @Input() visible: boolean = false;
  @Input() initialMode: 'blank' | 'upload' = 'blank';
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() projectCreated = new EventEmitter<ProjectItem>();

  public activeMode: 'blank' | 'upload' = 'blank';
  public projectName: string = '';
  public projectDesc: string = '';
  public adminUsername: string = 'admin';
  public adminPassword: string = '';
  public selectedColor: string = '#10b981';
  public selectedIcon: string = 'pi pi-folder';

  public isCreating: boolean = false;
  public isUploading: boolean = false;
  public errorMessage: string = '';

  // Upload & Inspection state
  public tempFileKey: string = '';
  public uploadedFileName: string = '';
  public inspectionReport: DbInspectionReport | null = null;

  // Real-time Command Log Console state
  public showConsole: boolean = false;
  public commandLogs: string[] = [];
  public createdProject: ProjectItem | null = null;

  public colorPresets: string[] = [
    '#10b981', // Emerald
    '#6366f1', // Indigo
    '#8b5cf6', // Violet
    '#f43f5e', // Rose
    '#f59e0b', // Amber
    '#06b6d4', // Cyan
    '#3b82f6'  // Blue
  ];

  public iconPresets: Array<{ label: string; icon: string }> = [
    { label: 'Folder', icon: 'pi pi-folder' },
    { label: 'Database', icon: 'pi pi-database' },
    { label: 'Business / Enterprise', icon: 'pi pi-building' },
    { label: 'Healthcare / Clinic', icon: 'pi pi-heart-fill' },
    { label: 'Store / Retail', icon: 'pi pi-shopping-bag' },
    { label: 'Ledger / Accounting', icon: 'pi pi-book' },
    { label: 'Analytics / Reports', icon: 'pi pi-chart-line' },
    { label: 'Spreadsheet / Grid', icon: 'pi pi-table' }
  ];

  constructor(
    private projectContext: ProjectContextService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialMode'] && this.initialMode) {
      this.activeMode = this.initialMode;
    }
    if (changes['visible'] && this.visible) {
      if (this.initialMode) {
        this.activeMode = this.initialMode;
      }
    }
  }

  public get calculatedSlug(): string {
    if (!this.projectName) return '';
    return this.projectName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  public get calculatedDbFile(): string {
    const s = this.calculatedSlug;
    return s ? `${s}.db` : '';
  }

  public switchMode(mode: 'blank' | 'upload'): void {
    this.activeMode = mode;
    this.errorMessage = '';
    this.cdr.markForCheck();
  }

  public formatFileSize(bytes?: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  public onFileSelected(event: any): void {
    const file = event?.target?.files?.[0];
    if (!file) return;

    this.errorMessage = '';
    this.isUploading = true;
    this.uploadedFileName = file.name;

    this.projectContext.uploadDbTemp(file).subscribe({
      next: (res) => {
        this.isUploading = false;
        if (res && res.success) {
          this.tempFileKey = res.tempFileKey;
          this.inspectionReport = res.inspection;

          // Auto-suggest project name from filename if empty
          if (!this.projectName || !this.projectName.trim()) {
            const rawName = (res.originalName || file.name)
              .replace(/\.(db|sqlite|sqlite3)$/i, '')
              .replace(/[_\-]+/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase());
            this.projectName = rawName;
          }
        } else {
          this.errorMessage = 'डेटाबेस फ़ाइल अपलोड विफल हुई';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isUploading = false;
        this.errorMessage = err?.error?.error || err?.message || 'फ़ाइल अपलोड एवं निरीक्षण विफल';
        this.cdr.markForCheck();
      }
    });
  }

  public resetFileSelection(inputEl?: HTMLInputElement): void {
    this.tempFileKey = '';
    this.uploadedFileName = '';
    this.inspectionReport = null;
    if (inputEl) {
      inputEl.value = '';
    }
    this.cdr.markForCheck();
  }

  public close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.resetForm();
  }

  public resetForm(): void {
    this.activeMode = this.initialMode || 'blank';
    this.projectName = '';
    this.projectDesc = '';
    this.adminUsername = 'admin';
    this.adminPassword = '';
    this.selectedColor = '#10b981';
    this.selectedIcon = 'pi pi-folder';
    this.errorMessage = '';
    this.isCreating = false;
    this.isUploading = false;
    this.tempFileKey = '';
    this.uploadedFileName = '';
    this.inspectionReport = null;
    this.showConsole = false;
    this.commandLogs = [];
    this.createdProject = null;
  }

  public launchCreatedProject(): void {
    if (this.createdProject) {
      this.projectCreated.emit(this.createdProject);
      this.close();
    }
  }

  public submitCreate(): void {
    this.errorMessage = '';
    if (!this.projectContext.canCreateProject) {
      this.errorMessage = 'अनुमति अस्वीकृत: आपके पास नया प्रोजेक्ट बनाने का अधिकार नहीं है (Permission Denied)';
      return;
    }

    if (this.activeMode === 'upload' && !this.tempFileKey) {
      this.errorMessage = 'कृपया आगे बढ़ने से पहले एक वैध SQLite डेटाबेस फ़ाइल (.db) चुनें।';
      return;
    }

    if (!this.projectName || !this.projectName.trim()) {
      this.errorMessage = 'प्रोजेक्ट का नाम अनिवार्य है (Project name is required)';
      return;
    }

    // Password is now completely OPTIONAL (Rule: Defaults to 'admin' if empty)
    const adminPass = this.adminPassword?.trim() || 'admin';

    this.isCreating = true;
    this.showConsole = true;
    this.createdProject = null;
    this.commandLogs = [
      `[INIT] Launching ${this.activeMode === 'upload' ? 'SQLite Database Adoption' : 'Blank Project Initialization'}...`,
      `[CONFIG] Project: "${this.projectName.trim()}" (Admin: ${this.adminUsername.trim() || 'admin'})`
    ];
    this.cdr.markForCheck();

    const payload = {
      name: this.projectName.trim(),
      description: this.projectDesc.trim(),
      username: this.adminUsername.trim() || 'admin',
      password: adminPass,
      color: this.selectedColor,
      icon: this.selectedIcon,
      dbSource: this.activeMode,
      tempFileKey: this.activeMode === 'upload' ? this.tempFileKey : undefined
    };

    this.projectContext.createProject(payload).subscribe({
      next: (res) => {
        if (res && res.success && res.result) {
          const incomingLogs = res.logs || [];
          if (incomingLogs.length > 0) {
            // Stream incoming logs smoothly
            let i = 0;
            const interval = setInterval(() => {
              if (i < incomingLogs.length) {
                this.commandLogs.push(incomingLogs[i]);
                this.cdr.markForCheck();
                i++;
              } else {
                clearInterval(interval);
                this.commandLogs.push('[SUCCESS] All operations completed successfully! Ready to launch.');
                this.isCreating = false;
                this.createdProject = res.result;
                this.cdr.markForCheck();
              }
            }, 80);
          } else {
            this.commandLogs.push('[SUCCESS] Project created successfully! Ready to launch.');
            this.isCreating = false;
            this.createdProject = res.result;
            this.cdr.markForCheck();
          }
        } else {
          this.isCreating = false;
          this.errorMessage = res?.message || 'त्रुटि: प्रोजेक्ट नहीं बन सका';
          this.commandLogs.push(`[ERROR] ${this.errorMessage}`);
          this.cdr.markForCheck();
        }
      },
      error: (err) => {
        this.isCreating = false;
        this.errorMessage = err?.error?.error || err?.message || 'Server error while creating project';
        this.commandLogs.push(`[FATAL ERROR] ${this.errorMessage}`);
        this.cdr.markForCheck();
      }
    });
  }
}
