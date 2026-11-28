import { Component, OnInit, OnDestroy, Input, Output, EventEmitter, ChangeDetectorRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { MenuItem } from 'primeng/api';
import { ContextMenu } from 'primeng/contextmenu';
import { ProjectContextService } from '../../services/project-context.service';
import { LanNetworkService, LanNodeInfo, LanPeer } from '../../services/lan-network.service';
import { ProjectItem, MasterUser } from '../../models/project.model';

export interface NetworkProjectItem {
  peer: LanPeer;
  project: {
    id: string;
    name: string;
    authType: 'none' | 'pin' | 'password';
    tablesCount?: number;
    description?: string;
  };
}

@Component({
  selector: 'app-project-hub',
  templateUrl: './project-hub.component.html',
  styleUrls: ['./project-hub.component.scss']
})
export class ProjectHubComponent implements OnInit, OnDestroy {
  @Input() isDarkMode: boolean = false;
  @Input() isServerOnline: boolean = true;
  @Input() serverPort: number = 3300;
  @Output() openProject = new EventEmitter<ProjectItem>();
  @Output() toggleTheme = new EventEmitter<void>();
  @Output() logout = new EventEmitter<void>();
  @Output() openLanModal = new EventEmitter<void>();
  @Output() openUpdateModal = new EventEmitter<void>();
  @Output() emergencyReset = new EventEmitter<void>();

  public projects: ProjectItem[] = [];
  public searchQuery: string = '';
  public showCreateModal: boolean = false;
  public initialModalMode: 'blank' | 'upload' = 'blank';
  public showMasterUsersModal: boolean = false;
  public activeMasterUser: MasterUser | null = null;
  public isLoading: boolean = false;

  // ── LAN & Context Menu State ──
  public localNode: LanNodeInfo | null = null;
  public peers: LanPeer[] = [];
  public isScanningLan: boolean = false;
  public projectMenuItems: MenuItem[] = [];
  public selectedProjectForMenu: ProjectItem | null = null;

  // ── Quick Share Dialog ──
  public showQuickShareModal: boolean = false;
  public sharingProject: ProjectItem | null = null;
  public quickAuthType: 'pin' | 'password' | 'none' = 'pin';
  public quickPin: string = '1234';
  public quickPassword: string = '';
  public isSharingSubmitting: boolean = false;
  public shareError: string = '';

  // ── Remote LAN Authentication Modal ──
  public showRemoteAuthModal: boolean = false;
  public selectedRemotePeer: LanPeer | null = null;
  public selectedRemoteProject: any = null;
  public authChallenge: string = '';
  public authSecretInput: string = '';
  public authError: string = '';
  public isAuthenticating: boolean = false;

  private subs: Subscription[] = [];

  public get canCreateProject(): boolean {
    return this.projectContext.canCreateProject;
  }

  public onCreateProjectClick(mode: 'blank' | 'upload' = 'blank'): void {
    if (!this.canCreateProject) {
      alert('Permission Denied: Only administrators can create new projects.');
      return;
    }
    this.initialModalMode = mode;
    this.showCreateModal = true;
    this.cdr.markForCheck();
  }

  constructor(
    public projectContext: ProjectContextService,
    public lanService: LanNetworkService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    if (this.projectContext.projects && this.projectContext.projects.length > 0) {
      this.projects = this.projectContext.projects;
    }

    this.subs.push(
      this.projectContext.masterUser$.subscribe(u => {
        this.activeMasterUser = u;
        this.loadProjects();
      }),
      this.projectContext.projects$.subscribe(list => {
        this.projects = list;
        this.cdr.markForCheck();
      }),
      this.lanService.localNode$.subscribe(node => {
        this.localNode = node;
        this.cdr.markForCheck();
      }),
      this.lanService.peers$.subscribe(peers => {
        this.peers = peers;
        this.cdr.markForCheck();
      })
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  public loadProjects(): void {
    this.isLoading = true;
    this.projectContext.loadProjects().subscribe({
      next: () => {
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoading = false;
        this.cdr.markForCheck();
      }
    });
  }

  public get filteredProjects(): ProjectItem[] {
    if (!this.searchQuery || !this.searchQuery.trim()) {
      return this.projects;
    }
    const q = this.searchQuery.toLowerCase().trim();
    return this.projects.filter(p =>
      p.project_name.toLowerCase().includes(q) ||
      p.project_slug.toLowerCase().includes(q) ||
      (p.description && p.description.toLowerCase().includes(q))
    );
  }

  public isProjectOpen(slug: string): boolean {
    return (this.projectContext.openProjects || []).some(p => p.project_slug === slug);
  }

  public openMasterUsersModal(): void {
    this.showMasterUsersModal = true;
    this.cdr.markForCheck();
  }

  public launchProject(project: ProjectItem): void {
    this.projectContext.setActiveProject(project);
    this.openProject.emit(project);
  }

  public onProjectCreated(newProject: ProjectItem): void {
    this.launchProject(newProject);
  }

  public deleteProject(p: ProjectItem, event?: Event): void {
    if (event) event.stopPropagation();
    let purge = false;
    if (p.db_type === 'mysql') {
      const confirmDelete = confirm(`Remove project "${p.project_name}" (${p.project_slug}) from Sutram?`);
      if (!confirmDelete) return;
      let parsedConfig: any = null;
      if (typeof p.db_config === 'string') {
        try { parsedConfig = JSON.parse(p.db_config); } catch {}
      } else if (p.db_config && typeof p.db_config === 'object') {
        parsedConfig = p.db_config;
      }
      const targetDb = p.mysql_database || parsedConfig?.database || p.project_slug;
      purge = confirm(`Clean-up Database?\n\nDo you also want to PURGE all Sutram metadata (sys_* tables) from the MySQL database "${targetDb}" so zero evidence of Sutram remains?`);
    } else {
      if (!confirm(`Archive project "${p.project_name}" (${p.project_slug})?`)) {
        return;
      }
    }
    this.projectContext.deleteProject(p.project_slug, purge).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.loadProjects();
        }
      },
      error: (err) => {
        alert('Error: ' + (err?.error?.error || err?.message || 'Failed to archive project'));
      }
    });
  }

  public copyProjectSlug(p: ProjectItem): void {
    try {
      navigator.clipboard.writeText(`${p.project_slug}.db`);
    } catch {}
  }

  public formatBytes(bytes?: number): string {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ─────────────────────────────────────────────────────────────
  // LAN Visibility & Context Menu Helpers
  // ─────────────────────────────────────────────────────────────
  public isProjectLive(slug: string): boolean {
    if (!this.localNode || !this.localNode.projects) return false;
    return this.localNode.projects.some(p => p.id === slug);
  }

  public getLiveProjectInfo(slug: string): any {
    if (!this.localNode || !this.localNode.projects) return null;
    return this.localNode.projects.find(p => p.id === slug) || null;
  }

  public onCardContextMenu(event: MouseEvent, p: ProjectItem, cm: ContextMenu): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedProjectForMenu = p;
    const isLive = this.isProjectLive(p.project_slug);

    this.projectMenuItems = [
      {
        label: isLive ? 'Stop Sharing (Private)' : 'Share on LAN',
        icon: isLive ? 'pi pi-lock' : 'pi pi-globe',
        command: () => this.toggleProjectShare(p)
      },
      {
        separator: true
      },
      {
        label: 'Open Project',
        icon: 'pi pi-folder-open',
        command: () => this.launchProject(p)
      },
      {
        label: 'Copy DB Name',
        icon: 'pi pi-copy',
        command: () => this.copyProjectSlug(p)
      },
      {
        separator: true
      },
      {
        label: 'Archive Project',
        icon: 'pi pi-trash',
        styleClass: 'text-danger',
        command: () => this.deleteProject(p)
      }
    ];

    cm.show(event);
  }

  public toggleProjectShare(p: ProjectItem, event?: MouseEvent): void {
    if (event) {
      event.stopPropagation();
    }
    if (this.isProjectLive(p.project_slug)) {
      this.unshareProject(p);
    } else {
      this.openShareConfig(p);
    }
  }

  public openShareConfig(p: ProjectItem): void {
    this.sharingProject = p;
    this.quickAuthType = 'pin';
    this.quickPin = '1234';
    this.quickPassword = '';
    this.shareError = '';
    this.showQuickShareModal = true;
    this.cdr.markForCheck();
  }

  public confirmQuickShare(): void {
    if (!this.sharingProject) return;

    const cleanPin = (this.quickPin ?? '').trim();
    const cleanPass = (this.quickPassword ?? '').trim();
    const effectiveAuthType: 'none' | 'pin' | 'password' =
      this.quickAuthType === 'pin'
        ? (cleanPin ? 'pin' : 'none')
        : (this.quickAuthType === 'password' ? (cleanPass ? 'password' : 'none') : 'none');

    this.isSharingSubmitting = true;
    this.shareError = '';

    this.lanService.shareProject({
      projectId: this.sharingProject.project_slug,
      name: this.sharingProject.project_name,
      authType: effectiveAuthType,
      pin: effectiveAuthType === 'pin' ? cleanPin : undefined,
      password: effectiveAuthType === 'password' ? cleanPass : undefined,
      description: this.sharingProject.description || ''
    }).subscribe({
      next: (res) => {
        this.isSharingSubmitting = false;
        if (res.success) {
          this.showQuickShareModal = false;
          this.sharingProject = null;
        } else {
          this.shareError = res.error || 'Failed to share project';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isSharingSubmitting = false;
        this.shareError = err?.error?.error || err.message || 'Network error';
        this.cdr.markForCheck();
      }
    });
  }

  public unshareProject(p: ProjectItem): void {
    this.lanService.unshareProject(p.project_slug).subscribe({
      next: () => {
        this.cdr.markForCheck();
      }
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Network Projects (LAN Workspaces) Direct Card Helpers
  // ─────────────────────────────────────────────────────────────
  public refreshLan(): void {
    this.isScanningLan = true;
    this.lanService.refreshStatus().subscribe({
      next: () => {
        this.isScanningLan = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.isScanningLan = false;
        this.cdr.markForCheck();
      }
    });
  }

  public get networkProjectsList(): NetworkProjectItem[] {
    const list: NetworkProjectItem[] = [];
    if (!this.peers || this.peers.length === 0) return list;

    for (const peer of this.peers) {
      if (Array.isArray(peer.projects)) {
        for (const proj of peer.projects) {
          list.push({ peer, project: proj });
        }
      }
    }
    return list;
  }

  public connectToNetworkProject(item: NetworkProjectItem): void {
    const { peer, project: rp } = item;
    const remoteBaseUrl = `http://${peer.ip}:${peer.httpPort || 3300}`;

    if (rp.authType === 'none') {
      window.open(`${remoteBaseUrl}/#project=${encodeURIComponent(rp.id)}`, '_blank');
      return;
    }

    this.selectedRemotePeer = peer;
    this.selectedRemoteProject = rp;
    this.authError = '';
    this.authSecretInput = '';
    this.isAuthenticating = true;

    this.lanService.requestChallenge(rp.id, remoteBaseUrl).subscribe({
      next: (res) => {
        this.isAuthenticating = false;
        if (res.success && res.challenge) {
          this.authChallenge = res.challenge;
          this.showRemoteAuthModal = true;
          this.cdr.markForCheck();
        } else {
          alert(res.error || 'Could not connect to peer');
        }
      },
      error: (err) => {
        this.isAuthenticating = false;
        alert(`Cannot connect to ${peer.name} (${remoteBaseUrl}): ${err.message || 'Peer unreachable'}`);
      }
    });
  }

  public submitRemoteAuth(): void {
    if (!this.selectedRemotePeer || !this.selectedRemoteProject || !this.authChallenge) return;

    if (!this.authSecretInput || this.authSecretInput.trim().length === 0) {
      this.authError = 'Please enter PIN or password';
      return;
    }

    const remoteBaseUrl = `http://${this.selectedRemotePeer.ip}:${this.selectedRemotePeer.httpPort || 3300}`;
    this.isAuthenticating = true;
    this.authError = '';

    this.lanService.authenticate(this.authChallenge, this.authSecretInput.trim(), remoteBaseUrl).subscribe({
      next: (res) => {
        this.isAuthenticating = false;
        if (res.success && res.token) {
          this.showRemoteAuthModal = false;
          window.open(
            `${remoteBaseUrl}/#project=${encodeURIComponent(this.selectedRemoteProject.id)}&lanToken=${encodeURIComponent(res.token)}`,
            '_blank'
          );
        } else {
          this.authError = res.error || 'Invalid PIN or password';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isAuthenticating = false;
        this.authError = err?.error?.error || 'Authentication failed';
        this.cdr.markForCheck();
      }
    });
  }
}
