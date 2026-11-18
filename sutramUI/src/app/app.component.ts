import { Component, OnInit, ChangeDetectorRef, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SutramExcelStudioComponent } from '../ng-sutramui-excel/lib/components/sutram-excel-studio/sutram-excel-studio.component';
import { ProjectContextService } from './services/project-context.service';
import { ProjectItem, MasterUser } from './models/project.model';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  @ViewChild('studio') public studioComponent?: SutramExcelStudioComponent;
  public selectedTable: string = '';
  public tablesList: Array<{ name: string; display: string }> = [];
  public isServerOnline: boolean = false;
  public isDarkMode: boolean = false;
  public showingHub: boolean = false;
  public isStudioMounted: boolean = false;
  public projectTables: { [slug: string]: string } = {};
  public showProjectUsersModal: boolean = false;
  public showLanModal: boolean = false;
  public showUpdateModal: boolean = false;

  public onOpenProjectUsersModal(): void {
    this.showProjectUsersModal = true;
    this.cdr.markForCheck();
  }

  public onOpenLanModal(): void {
    this.showLanModal = true;
    this.cdr.markForCheck();
  }

  public onOpenUpdateModal(): void {
    this.showUpdateModal = true;
    this.cdr.markForCheck();
  }

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    public projectContext: ProjectContextService
  ) {}

  public ngOnInit(): void {
    const savedTheme = localStorage.getItem('sutram_dark_mode');
    if (savedTheme === 'true' || document.body.classList.contains('dark-mode')) {
      this.isDarkMode = true;
      document.body.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark-theme');
      document.body.classList.add('dark-mode');
    }
    this.checkServerHealth();

    // Restore projectTables map from localStorage
    try {
      const rawMap = localStorage.getItem('sutram_project_tables_map');
      if (rawMap) {
        this.projectTables = JSON.parse(rawMap) || {};
      }
    } catch {}

    if (!this.projectContext.isAuthenticated) {
      this.showingHub = false;
      this.isStudioMounted = false;
      return;
    }

    if (this.projectContext.openProjects.length === 0) {
      this.showingHub = true;
      this.isStudioMounted = false;
    } else if (this.projectContext.activeProject) {
      // Force cleanly activate the restored active project on page reload/refresh
      this.onSelectProjectTab(this.projectContext.activeProject, true);
    }
  }

  public onMasterLoginSuccess(user: MasterUser): void {
    if (this.projectContext.openProjects.length === 0) {
      this.showingHub = true;
      this.isStudioMounted = false;
    } else if (this.projectContext.activeProject) {
      this.onSelectProjectTab(this.projectContext.activeProject, true);
    } else {
      this.showingHub = true;
      this.isStudioMounted = false;
    }
    this.cdr.markForCheck();
  }

  public onLogout(): void {
    this.projectContext.logoutMasterUser();
    this.showingHub = false;
    this.isStudioMounted = false;
    this.selectedTable = '';
    this.tablesList = [];
    this.cdr.markForCheck();
  }

  public onOpenProject(project: ProjectItem): void {
    this.projectContext.openProject(project);
    this.onSelectProjectTab(project, true);
  }

  public onSelectProjectTab(project: ProjectItem, forceSwitch: boolean = false): void {
    if (!forceSwitch && this.projectContext.activeProject?.project_slug === project.project_slug && !this.showingHub && this.isStudioMounted) {
      return;
    }

    // Check if current studio has un-synced edits before switching
    if (this.isStudioMounted && this.studioComponent?.state?.pendingChangesCount() > 0) {
      const confirmLeave = confirm('मौजूदा प्रोजेक्ट में अनसेव्ड डेटा मौजूद है। क्या आप दूसरे प्रोजेक्ट पर स्विच करना चाहते हैं? (Unsaved changes in active project will be lost. Switch anyway?)');
      if (!confirmLeave) return;
    }

    this.showingHub = false;
    this.isStudioMounted = false;
    this.projectContext.setActiveProject(project);

    const savedTable = this.projectTables[project.project_slug] || localStorage.getItem(`sutram_active_table_${project.project_slug}`) || '';
    this.selectedTable = savedTable;

    // Call server to instantly switch active database connection
    this.http.post(`/api/_sutram/master/projects/switch/${encodeURIComponent(project.project_slug)}`, {}).subscribe({
      next: () => {
        this.loadTablesForProject(project.project_slug, () => {
          this.isStudioMounted = true;
          this.cdr.markForCheck();
        });
      },
      error: () => {
        this.loadTablesForProject(project.project_slug, () => {
          this.isStudioMounted = true;
          this.cdr.markForCheck();
        });
      }
    });
  }

  public onCloseProjectTab(project: ProjectItem): void {
    this.projectContext.closeProject(project.project_slug);
    delete this.projectTables[project.project_slug];
    this.saveProjectTablesMap();
    if (this.projectContext.openProjects.length === 0) {
      this.showingHub = true;
      this.isStudioMounted = false;
    } else if (this.projectContext.activeProject) {
      this.onSelectProjectTab(this.projectContext.activeProject, true);
    }
    this.cdr.markForCheck();
  }

  public onGoToHub(): void {
    this.showingHub = true;
    this.cdr.markForCheck();
  }

  public trackBySlug(index: number, project: ProjectItem): string {
    return project.project_slug;
  }

  public checkServerHealth(): void {
    this.http.get<{ status: string }>('/api/health').subscribe({
      next: (res) => {
        this.isServerOnline = res?.status === 'online';
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isServerOnline = false;
        console.warn('[sutramUI] sutramServer health check warning:', err?.message || err);
        this.cdr.markForCheck();
      }
    });
  }

  public loadTablesForProject(slug: string, onDone?: () => void): void {
    this.http.get<{ success: boolean; result: any[] }>('/_sutram/excel/tables').subscribe({
      next: (res) => {
        if (res && res.success && Array.isArray(res.result)) {
          const list = res.result
            .filter(t => !(t.name || t.table).startsWith('sys_') && !(t.name || t.table).startsWith('sqlite_'))
            .map(t => ({
              name: t.name || t.table,
              display: t.display_name || t.name || t.table
            }));

          this.tablesList = list;

          // Determine selected table
          const savedTable = this.projectTables[slug] || localStorage.getItem(`sutram_active_table_${slug}`);
          const validSaved = list.find(t => t.name === savedTable);

          if (validSaved) {
            this.selectedTable = validSaved.name;
            this.projectTables[slug] = validSaved.name;
          } else if (list.length > 0) {
            this.selectedTable = list[0].name;
            this.projectTables[slug] = list[0].name;
            localStorage.setItem(`sutram_active_table_${slug}`, list[0].name);
          } else {
            this.selectedTable = '';
          }
          this.saveProjectTablesMap();
        }
        if (onDone) onDone();
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error(`[sutramUI] Could not load tables for project ${slug}:`, err);
        if (onDone) onDone();
        this.cdr.markForCheck();
      }
    });
  }

  private saveProjectTablesMap(): void {
    try {
      localStorage.setItem('sutram_project_tables_map', JSON.stringify(this.projectTables));
    } catch {}
  }

  public toggleTheme(): void {
    this.isDarkMode = !this.isDarkMode;
    if (this.isDarkMode) {
      document.body.setAttribute('data-theme', 'dark');
      document.body.classList.add('dark-theme');
      document.body.classList.add('dark-mode');
      localStorage.setItem('sutram_dark_mode', 'true');
    } else {
      document.body.removeAttribute('data-theme');
      document.body.classList.remove('dark-theme');
      document.body.classList.remove('dark-mode');
      localStorage.setItem('sutram_dark_mode', 'false');
    }
    this.cdr.markForCheck();
  }

  public onTableCreatedFromStudio(tableName: string): void {
    const slug = this.projectContext.activeProject?.project_slug;
    if (slug) {
      this.projectTables[slug] = tableName;
      localStorage.setItem(`sutram_active_table_${slug}`, tableName);
      this.saveProjectTablesMap();
    }
    this.selectedTable = tableName;
    if (slug) {
      this.loadTablesForProject(slug);
    }
    this.cdr.markForCheck();
  }
}
