import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectorRef } from '@angular/core';
import { ProjectContextService } from '../../services/project-context.service';
import { MasterUser, ProjectItem } from '../../models/project.model';

@Component({
  selector: 'app-master-users-modal',
  templateUrl: './master-users-modal.component.html',
  styleUrls: ['./master-users-modal.component.scss']
})
export class MasterUsersModalComponent implements OnInit {
  private _visible: boolean = false;

  @Input()
  public get visible(): boolean {
    return this._visible;
  }
  public set visible(val: boolean) {
    this._visible = val;
    if (val) {
      this.loadData();
    }
  }

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() userSwitched = new EventEmitter<void>();

  public masterUsers: MasterUser[] = [];
  public projects: ProjectItem[] = [];
  public selectedUser: MasterUser | null = null;
  public userAccessibleProjectIds: Set<number> = new Set();
  public isLoadingAccess: boolean = false;

  // Add User Form
  public isAddingUser: boolean = false;
  public newUsername: string = '';
  public newDisplayName: string = '';
  public newPassword: string = '';
  public newRole: 'superadmin' | 'admin' | 'user' = 'user';
  public newCanCreateProject: boolean = false;
  public formError: string = '';

  public roleOptions = [
    { label: 'Superadmin (सारे प्रोजेक्ट्स देख सकता है)', value: 'superadmin' },
    { label: 'Admin (प्रोजेक्ट एडमिनिस्ट्रेटर)', value: 'admin' },
    { label: 'Regular User (केवल अधिकृत प्रोजेक्ट्स)', value: 'user' }
  ];

  constructor(
    public projectContext: ProjectContextService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    if (this._visible) {
      this.loadData();
    }
  }

  public loadData(): void {
    this.projectContext.getMasterUsers().subscribe({
      next: (users) => {
        this.masterUsers = Array.isArray(users) ? users : [];
        if (!this.selectedUser && this.masterUsers.length > 0) {
          this.selectUser(this.masterUsers[0]);
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('[MasterUsersModal] Error loading users:', err);
        this.masterUsers = [];
        this.cdr.markForCheck();
      }
    });

    this.projectContext.projects$.subscribe(projs => {
      this.projects = Array.isArray(projs) ? projs : [];
      this.cdr.markForCheck();
    });
  }

  public selectUser(u: MasterUser): void {
    this.selectedUser = u;
    this.loadUserProjects(u._id);
    this.cdr.markForCheck();
  }

  public loadUserProjects(userId: number): void {
    this.isLoadingAccess = true;
    this.projectContext.getUserProjects(userId).subscribe({
      next: (accessList) => {
        this.userAccessibleProjectIds = new Set((accessList || []).map(a => a.project_id));
        this.isLoadingAccess = false;
        this.cdr.markForCheck();
      },
      error: () => {
        this.userAccessibleProjectIds = new Set();
        this.isLoadingAccess = false;
        this.cdr.markForCheck();
      }
    });
  }

  public toggleProjectAccess(p: ProjectItem): void {
    if (!this.selectedUser) return;
    const userId = this.selectedUser._id;
    const hasAccess = this.userAccessibleProjectIds.has(p._id);

    if (hasAccess) {
      this.projectContext.revokeProjectAccess(p.project_slug, userId).subscribe({
        next: () => {
          this.userAccessibleProjectIds.delete(p._id);
          this.cdr.markForCheck();
        }
      });
    } else {
      this.projectContext.grantProjectAccess(p.project_slug, userId, 'member').subscribe({
        next: () => {
          this.userAccessibleProjectIds.add(p._id);
          this.cdr.markForCheck();
        }
      });
    }
  }

  public toggleUserCanCreate(u: MasterUser): void {
    if (u.role === 'superadmin') return;
    const newVal = u.can_create_project === 1 ? 0 : 1;
    this.projectContext.updateMasterUser(u._id, { can_create_project: newVal }).subscribe({
      next: () => {
        u.can_create_project = newVal;
        this.cdr.markForCheck();
      },
      error: (err) => alert('अधिकार अपडेट विफल: ' + (err?.error?.error || err.message))
    });
  }

  public switchToUser(u: MasterUser): void {
    if (this.projectContext.activeMasterUser?.username === u.username) return;
    this.projectContext.setMasterUser(u);
    this.userSwitched.emit();
    this.close();
  }

  public close(): void {
    this._visible = false;
    this.visibleChange.emit(false);
    this.isAddingUser = false;
    this.formError = '';
    this.cdr.markForCheck();
  }

  public onRoleChange(): void {
    if (this.newRole === 'superadmin' || this.newRole === 'admin') {
      this.newCanCreateProject = true;
    } else {
      this.newCanCreateProject = false;
    }
  }

  public submitNewUser(): void {
    this.formError = '';
    if (!this.newUsername.trim() || !this.newPassword.trim()) {
      this.formError = 'यूज़रनेम और पासवर्ड अनिवार्य हैं';
      return;
    }

    this.projectContext.createMasterUser({
      username: this.newUsername.trim(),
      display_name: this.newDisplayName.trim() || this.newUsername.trim(),
      password: this.newPassword.trim(),
      role: this.newRole,
      can_create_project: (this.newRole === 'superadmin' || this.newCanCreateProject) ? 1 : 0
    }).subscribe({
      next: (res) => {
        if (res && res.success) {
          this.isAddingUser = false;
          this.newUsername = '';
          this.newDisplayName = '';
          this.newPassword = '';
          this.newRole = 'user';
          this.newCanCreateProject = false;
          this.loadData();
        } else {
          this.formError = res?.error || 'Failed to create user';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.formError = err?.error?.error || err?.message || 'Server error';
        this.cdr.markForCheck();
      }
    });
  }
}
