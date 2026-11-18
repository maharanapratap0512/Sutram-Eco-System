import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { ProjectContextService } from '../../services/project-context.service';
import { InProjectUser, ProjectItem } from '../../models/project.model';

export interface UserTableRight {
  table_name: string;
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_unmask: boolean;
}

@Component({
  selector: 'app-project-users-modal',
  templateUrl: './project-users-modal.component.html',
  styleUrls: ['./project-users-modal.component.scss']
})
export class ProjectUsersModalComponent implements OnInit, OnChanges {
  @Input() visible: boolean = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Input() project: ProjectItem | null = null;

  public users: InProjectUser[] = [];
  public selectedUser: InProjectUser | null = null;
  public availableTables: string[] = [];
  public userRights: UserTableRight[] = [];

  // Right pane mode: 'permissions' (default) | 'edit_user' | 'add_user'
  public rightViewMode: 'permissions' | 'edit_user' | 'add_user' = 'permissions';

  public isLoadingUsers: boolean = false;
  public isSavingRights: boolean = false;
  public isSavingUser: boolean = false;
  public rightsSavedNotice: boolean = false;

  // Search filter for table permissions matrix
  public tableSearchQuery: string = '';

  // Form fields for Add/Edit User
  public formUserId: number | null = null;
  public formUsername: string = '';
  public formDisplayName: string = '';
  public formPassword: string = '';
  public formRole: 'admin' | 'author' = 'author';
  public formCanOcr: boolean = true;
  public formError: string = '';

  public roleOptions = [
    { label: 'Author (ऑथर - डेटा प्रविष्टि एवं संपादन)', value: 'author' },
    { label: 'Admin (एडमिन - पूर्ण नियंत्रण)', value: 'admin' }
  ];

  constructor(
    private http: HttpClient,
    public projectContext: ProjectContextService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    if (this.visible) {
      this.loadProjectUsers();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible'] && changes['visible'].currentValue) {
      this.loadProjectUsers();
    }
    if (changes['project'] && changes['project'].currentValue && this.visible) {
      this.loadProjectUsers();
    }
  }

  private getProjectQuery(): string {
    const slug = this.project?.project_slug || this.projectContext.activeProject?.project_slug;
    return slug ? `?project=${encodeURIComponent(slug)}` : '';
  }

  public open(): void {
    this.visible = true;
    this.visibleChange.emit(true);
    this.loadProjectUsers();
  }

  public close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.rightViewMode = 'permissions';
    this.formError = '';
  }

  public loadProjectUsers(): void {
    this.isLoadingUsers = true;
    const query = this.getProjectQuery();

    forkJoin({
      usersRes: this.http.get<{ success: boolean; result: InProjectUser[] }>(`/api/_sutram/schema/users${query}`),
      tablesRes: this.http.get<{ success: boolean; result: Array<{ table_name: string }> }>(`/api/_sutram/schema/tables${query}`)
    }).subscribe({
      next: ({ usersRes, tablesRes }) => {
        this.isLoadingUsers = false;
        if (tablesRes && tablesRes.success && Array.isArray(tablesRes.result)) {
          this.availableTables = tablesRes.result.map(t => t.table_name);
        }
        if (usersRes && usersRes.success) {
          this.users = usersRes.result || [];
          if (this.users.length > 0) {
            const currentId = this.selectedUser?._id;
            const match = currentId ? this.users.find(u => u._id === currentId) : this.users[0];
            this.selectUser(match || this.users[0]);
          } else {
            this.selectedUser = null;
            this.userRights = [];
          }
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoadingUsers = false;
        console.error('[ProjectUsersModal] Error loading users/tables:', err);
        // Fallback: try loading users individually if tables failed
        this.http.get<{ success: boolean; result: InProjectUser[] }>(`/api/_sutram/schema/users${query}`).subscribe({
          next: (res) => {
            if (res && res.success) {
              this.users = res.result || [];
              if (this.users.length > 0) {
                this.selectUser(this.users[0]);
              }
            }
            this.cdr.markForCheck();
          }
        });
        this.cdr.markForCheck();
      }
    });
  }

  // ── Default Behavior: Selecting a user immediately updates permissions on the right ──
  public selectUser(u: InProjectUser): void {
    this.selectedUser = u;
    this.rightViewMode = 'permissions';
    this.rightsSavedNotice = false;
    this.loadUserRights(u._id);
  }

  public loadUserRights(userId: number): void {
    const query = this.getProjectQuery();
    this.http.get<{ success: boolean; result: any[] }>(`/api/_sutram/schema/user-rights/${userId}${query}`).subscribe({
      next: (res) => {
        const savedRights = (res && res.success && Array.isArray(res.result)) ? res.result : [];
        this.userRights = this.availableTables.map(tbl => {
          const match = savedRights.find(r => r.table_name === tbl);
          return {
            table_name: tbl,
            can_view: match ? match.can_view === 1 : true,
            can_edit: match ? match.can_edit === 1 : true,
            can_delete: match ? match.can_delete === 1 : true,
            can_unmask: match ? match.can_unmask === 1 : false
          };
        });
        this.cdr.markForCheck();
      }
    });
  }

  // ── Save Table Rights Only ──
  public saveUserRights(): void {
    if (!this.selectedUser) return;
    this.isSavingRights = true;
    this.rightsSavedNotice = false;
    const query = this.getProjectQuery();

    this.http.post(`/api/_sutram/schema/user-rights/${this.selectedUser._id}${query}`, { rights: this.userRights }).subscribe({
      next: () => {
        this.isSavingRights = false;
        this.rightsSavedNotice = true;
        setTimeout(() => {
          this.rightsSavedNotice = false;
          this.cdr.markForCheck();
        }, 3000);
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isSavingRights = false;
        alert('अधिकार सहेजने में त्रुटि: ' + (err?.error?.error || err?.message));
        this.cdr.markForCheck();
      }
    });
  }

  // ── Form Trigger: Open Edit User Form ──
  public startEditUser(u: InProjectUser, event?: Event): void {
    if (event) event.stopPropagation();
    this.selectedUser = u;
    this.rightViewMode = 'edit_user';
    this.formUserId = u._id;
    this.formUsername = u.username;
    this.formDisplayName = u.display_name || u.username;
    this.formRole = u.role;
    this.formPassword = '';
    this.formCanOcr = (u as any).can_ocr !== 0 && (u as any).can_ocr !== false;
    this.formError = '';
    this.loadUserRights(u._id);
    this.cdr.markForCheck();
  }

  // ── Form Trigger: Open Add User Form ──
  public startAddUser(): void {
    this.rightViewMode = 'add_user';
    this.formUserId = null;
    this.formUsername = '';
    this.formDisplayName = '';
    this.formPassword = '';
    this.formRole = 'author';
    this.formCanOcr = true;
    this.formError = '';
    this.cdr.markForCheck();
  }

  // ── Close Form and Return to Permissions View ──
  public closeUserForm(): void {
    this.rightViewMode = 'permissions';
    this.formError = '';
    this.cdr.markForCheck();
  }

  // ── Submit User Details (Create or Update) ──
  public submitUserForm(): void {
    this.formError = '';
    const query = this.getProjectQuery();

    if (this.rightViewMode === 'add_user') {
      if (!this.formUsername.trim() || !this.formPassword.trim()) {
        this.formError = 'यूज़रनेम और पासवर्ड अनिवार्य हैं';
        return;
      }
      this.isSavingUser = true;
      this.http.post<{ success: boolean; result: InProjectUser; error?: string }>(`/api/_sutram/schema/users${query}`, {
        username: this.formUsername.trim(),
        display_name: this.formDisplayName.trim() || this.formUsername.trim(),
        password: this.formPassword.trim(),
        role: this.formRole,
        can_ocr: this.formCanOcr ? 1 : 0
      }).subscribe({
        next: (res) => {
          this.isSavingUser = false;
          if (res && res.success && res.result) {
            this.rightViewMode = 'permissions';
            this.loadProjectUsers();
            this.selectUser(res.result);
          } else {
            this.formError = res?.error || 'Failed to create user';
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isSavingUser = false;
          this.formError = err?.error?.error || err?.message || 'Server error';
          this.cdr.markForCheck();
        }
      });
    } else if (this.rightViewMode === 'edit_user' && this.formUserId) {
      this.isSavingUser = true;
      const userPayload: any = {
        display_name: this.formDisplayName.trim() || this.formUsername,
        role: this.formRole,
        can_ocr: this.formCanOcr ? 1 : 0
      };
      if (this.formPassword.trim()) {
        userPayload.password = this.formPassword.trim();
      }

      this.http.put<{ success: boolean; result: InProjectUser; error?: string }>(`/api/_sutram/schema/users/${this.formUserId}${query}`, userPayload).subscribe({
        next: (res) => {
          this.isSavingUser = false;
          if (res && res.success && res.result) {
            if (this.selectedUser && this.selectedUser._id === this.formUserId) {
              Object.assign(this.selectedUser, res.result);
            }
            this.rightViewMode = 'permissions';
            this.loadProjectUsers();
          } else {
            this.formError = res?.error || 'Failed to update user';
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isSavingUser = false;
          this.formError = err?.error?.error || err?.message || 'Server error';
          this.cdr.markForCheck();
        }
      });
    }
  }

  // ── Delete User ──
  public deleteUser(u: InProjectUser, event: Event): void {
    event.stopPropagation();
    if (u.role === 'admin' && this.users.filter(x => x.role === 'admin').length <= 1) {
      alert('एकमात्र एडमिन को हटाया नहीं जा सकता (Cannot delete sole administrator)');
      return;
    }
    if (!confirm(`क्या आप प्रोजेक्ट यूज़र "${u.username}" को हटाना चाहते हैं?`)) return;

    const query = this.getProjectQuery();
    this.http.delete(`/api/_sutram/schema/users/${u._id}${query}`).subscribe({
      next: () => {
        this.loadProjectUsers();
      },
      error: (err) => {
        alert('त्रुटि: ' + (err?.error?.error || err?.message));
      }
    });
  }

  // ── Table Permissions Filter & Bulk Actions ──
  public get filteredUserRights(): UserTableRight[] {
    if (!this.tableSearchQuery.trim()) {
      return this.userRights;
    }
    const q = this.tableSearchQuery.trim().toLowerCase();
    return this.userRights.filter(r => r.table_name.toLowerCase().includes(q));
  }

  public toggleAll(col: 'can_view' | 'can_edit' | 'can_delete' | 'can_unmask'): void {
    const list = this.filteredUserRights;
    if (list.length === 0) return;
    const allChecked = list.every(r => r[col]);
    const targetState = !allChecked;
    list.forEach(r => r[col] = targetState);
    this.cdr.markForCheck();
  }
}
