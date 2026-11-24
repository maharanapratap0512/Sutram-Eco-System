import { Component, Input, Output, EventEmitter, ChangeDetectorRef, OnChanges, SimpleChanges } from '@angular/core';
import { ProjectContextService } from '../../services/project-context.service';
import { ProjectItem, DbInspectionReport, MySqlDatabaseItem } from '../../models/project.model';
import { Subject, debounceTime } from 'rxjs';

@Component({
  selector: 'app-create-project-modal',
  templateUrl: './create-project-modal.component.html',
  styleUrls: ['./create-project-modal.component.scss']
})
export class CreateProjectModalComponent implements OnChanges {
  @Input() visible: boolean = false;
  @Input() initialMode: 'blank' | 'upload' | 'mysql' = 'blank';
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() projectCreated = new EventEmitter<ProjectItem>();

  // ── Project Identity & Appearance (Top Section) ────────────────
  public projectName: string = '';
  public projectDesc: string = '';
  public adminUsername: string = 'admin';
  public adminPassword: string = '';
  public selectedColor: string = '#10b981';
  public selectedIcon: string = 'pi pi-folder';

  public isCreating: boolean = false;
  public errorMessage: string = '';

  // ── SQLite File Upload State ───────────────────────────────────
  public isUploading: boolean = false;
  public tempFileKey: string = '';
  public uploadedFileName: string = '';
  public sqliteInspectionReport: DbInspectionReport | null = null;

  // ── MySQL Server Connection & Clone State ──────────────────────
  public mysqlHost: string = 'localhost';
  public mysqlPort: number = 3306;
  public mysqlUser: string = 'root';
  public mysqlPass: string = '';
  public selectedDatabase: string = '';
  public mysqlIsNewDb: boolean = false;
  public mysqlClone: boolean = false;
  public mysqlClonedDbName: string = '';
  public isFetchingDatabases: boolean = false;
  public isInspectingMysql: boolean = false;
  public availableDatabases: MySqlDatabaseItem[] = [];
  public databaseOptions: Array<{ label: string; value: string; isSutram?: boolean; count?: number }> = [];
  public mysqlInspectionReport: DbInspectionReport | null = null;
  private mysqlCredsChange$ = new Subject<void>();

  // ── Real-time Engine Console State ─────────────────────────────
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
  ) {
    this.mysqlCredsChange$.pipe(
      debounceTime(400)
    ).subscribe(() => {
      this.fetchMySQLDatabases();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible'] && this.visible) {
      if (this.initialMode === 'mysql') {
        this.fetchMySQLDatabases();
      }
    }
  }

  // ── Reactive Mode & Exclusion Getters ──────────────────────────

  /** SQLite file is selected and ready */
  public get isSqliteSelected(): boolean {
    return !!this.tempFileKey;
  }

  /** MySQL server box is being configured / selected */
  public get isMySqlActive(): boolean {
    if (this.isSqliteSelected) return false;
    return !!(this.selectedDatabase || this.mysqlPass || (this.availableDatabases && this.availableDatabases.length > 0));
  }

  /** Resolved engine mode */
  public get resolvedMode(): 'blank' | 'upload' | 'mysql' {
    if (this.tempFileKey) return 'upload';
    if (this.selectedDatabase && (this.mysqlHost || this.mysqlUser)) return 'mysql';
    return 'blank';
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
    if (this.resolvedMode === 'mysql') {
      const db = this.mysqlClone ? (this.mysqlClonedDbName || `${this.selectedDatabase}_copy`) : this.selectedDatabase;
      return db ? `mysql://${db}` : '';
    }
    const s = this.calculatedSlug;
    return s ? `${s}.db` : '';
  }

  public get submitButtonLabel(): string {
    if (this.resolvedMode === 'upload') return 'Attach & Open Project';
    if (this.resolvedMode === 'mysql') {
      if (this.mysqlClone) return 'Clone & Open Project';
      return this.mysqlIsNewDb ? 'Create MySQL Project' : 'Connect & Open Project';
    }
    return 'Create & Open Project';
  }

  // ── MySQL Methods ──────────────────────────────────────────────

  public onMySQLCredsInput(): void {
    this.mysqlCredsChange$.next();
  }

  public fetchMySQLDatabases(): void {
    if (!this.mysqlHost || !this.mysqlUser) return;
    this.isFetchingDatabases = true;
    this.errorMessage = '';
    this.cdr.markForCheck();

    this.projectContext.listMySqlDatabases({
      host: this.mysqlHost.trim(),
      port: Number(this.mysqlPort || 3306),
      user: this.mysqlUser.trim(),
      password: this.mysqlPass
    }).subscribe({
      next: (res) => {
        this.isFetchingDatabases = false;
        if (res && res.success && Array.isArray(res.result)) {
          this.availableDatabases = res.result;
          this.databaseOptions = res.result.map(db => ({
            label: `${db.name} (${db.isSutram ? 'Sutram DB' : db.tableCount + ' tables'})`,
            value: db.name,
            isSutram: db.isSutram,
            count: db.tableCount
          }));
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isFetchingDatabases = false;
        console.warn('[MySQL Auto-Discovery notice]:', err?.error?.error || err?.message);
        this.cdr.markForCheck();
      }
    });
  }

  public onDatabaseSelected(event: any): void {
    const val = typeof event === 'string' ? event : (event?.value || event?.target?.value || this.selectedDatabase);
    if (!val) return;
    this.selectedDatabase = String(val).trim();

    const existing = this.availableDatabases.find(d => d.name.toLowerCase() === this.selectedDatabase.toLowerCase());
    this.mysqlIsNewDb = !existing;

    if (existing) {
      this.mysqlClonedDbName = `${this.selectedDatabase}_copy`;
      this.isInspectingMysql = true;
      this.projectContext.inspectMySqlDatabase({
        host: this.mysqlHost.trim(),
        port: Number(this.mysqlPort || 3306),
        user: this.mysqlUser.trim(),
        password: this.mysqlPass,
        database: this.selectedDatabase
      }).subscribe({
        next: (res) => {
          this.isInspectingMysql = false;
          if (res && res.success && res.result) {
            this.mysqlInspectionReport = res.result;
          }
          this.cdr.markForCheck();
        },
        error: () => {
          this.isInspectingMysql = false;
          this.cdr.markForCheck();
        }
      });
    } else {
      this.mysqlClone = false;
      this.mysqlClonedDbName = '';
      this.mysqlInspectionReport = null;
    }

    if (!this.projectName || !this.projectName.trim()) {
      this.projectName = this.selectedDatabase.replace(/[_\-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }

    this.cdr.markForCheck();
  }

  public resetMySqlConfig(): void {
    this.selectedDatabase = '';
    this.mysqlPass = '';
    this.mysqlClone = false;
    this.mysqlClonedDbName = '';
    this.mysqlInspectionReport = null;
    this.cdr.markForCheck();
  }

  // ── SQLite Methods ─────────────────────────────────────────────

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
          this.sqliteInspectionReport = res.inspection;

          if (!this.projectName || !this.projectName.trim()) {
            const rawName = (res.originalName || file.name)
              .replace(/\.(db|sqlite|sqlite3)$/i, '')
              .replace(/[_\-]+/g, ' ')
              .replace(/\b\w/g, l => l.toUpperCase());
            this.projectName = rawName;
          }
        } else {
          this.errorMessage = 'Database file upload failed';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isUploading = false;
        this.errorMessage = err?.error?.error || err?.message || 'File upload & inspection failed';
        this.cdr.markForCheck();
      }
    });
  }

  public resetFileSelection(inputEl?: HTMLInputElement): void {
    this.tempFileKey = '';
    this.uploadedFileName = '';
    this.sqliteInspectionReport = null;
    if (inputEl) {
      inputEl.value = '';
    }
    this.cdr.markForCheck();
  }

  public formatFileSize(bytes?: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ── Modal Lifecycle & Submit ───────────────────────────────────

  public close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.resetForm();
  }

  public resetForm(): void {
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
    this.sqliteInspectionReport = null;
    this.resetMySqlConfig();
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
      this.errorMessage = 'Permission Denied: You do not have permission to create projects';
      return;
    }

    if (!this.projectName || !this.projectName.trim()) {
      this.errorMessage = 'Project name is required';
      return;
    }

    const mode = this.resolvedMode;

    if (mode === 'mysql' && !this.selectedDatabase) {
      this.errorMessage = 'Please select or type a MySQL database name';
      return;
    }

    if (mode === 'mysql' && this.mysqlClone && (!this.mysqlClonedDbName || !this.mysqlClonedDbName.trim())) {
      this.errorMessage = 'Please provide a target database name for the clone';
      return;
    }

    const adminPass = this.adminPassword?.trim() || 'admin';
    this.isCreating = true;
    this.showConsole = true;
    this.createdProject = null;

    let targetDb = this.selectedDatabase.trim();
    if (mode === 'mysql' && this.mysqlClone && this.mysqlClonedDbName.trim()) {
      targetDb = this.mysqlClonedDbName.trim();
    }

    this.commandLogs = [
      `[INIT] Launching ${mode === 'upload' ? 'SQLite Database Adoption' : (mode === 'mysql' ? (this.mysqlClone ? 'MySQL Database Clone & Setup' : 'MySQL Database Integration') : 'Blank Project Initialization')}...`,
      `[CONFIG] Project: "${this.projectName.trim()}" (Admin: ${this.adminUsername.trim() || 'admin'})`
    ];
    this.cdr.markForCheck();

    const payload: any = {
      name: this.projectName.trim(),
      description: this.projectDesc.trim(),
      username: this.adminUsername.trim() || 'admin',
      password: adminPass,
      color: this.selectedColor,
      icon: mode === 'mysql' ? (this.selectedIcon || 'pi pi-server') : this.selectedIcon,
      dbSource: mode,
      db_type: mode === 'mysql' ? 'mysql' : 'sqlite',
      tempFileKey: mode === 'upload' ? this.tempFileKey : undefined,
      mysql_config: mode === 'mysql' ? {
        host: this.mysqlHost.trim(),
        port: Number(this.mysqlPort || 3306),
        user: this.mysqlUser.trim(),
        password: this.mysqlPass,
        database: targetDb,
        create_if_missing: this.mysqlIsNewDb || this.mysqlClone,
        clone: this.mysqlClone,
        clone_source_db: this.mysqlClone ? this.selectedDatabase.trim() : undefined
      } : undefined
    };

    this.projectContext.createProject(payload).subscribe({
      next: (res) => {
        if (res && res.success && res.result) {
          const incomingLogs = res.logs || [];
          if (incomingLogs.length > 0) {
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
          this.errorMessage = res?.message || 'Error: Could not create project';
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
