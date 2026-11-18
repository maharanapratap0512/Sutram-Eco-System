/**
 * project-context.service.ts
 * ─────────────────────────────────────────────────────────────
 * Central State & API Service for Sutram Projects Hub & Workspaces.
 * ─────────────────────────────────────────────────────────────
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, map, tap, catchError, of, throwError } from 'rxjs';
import { ProjectItem, MasterUser, InProjectUser, ProjectCreatePayload, ProjectMember, DbInspectionReport } from '../models/project.model';

@Injectable({
  providedIn: 'root'
})
export class ProjectContextService {
  private activeProjectSubject = new BehaviorSubject<ProjectItem | null>(null);
  public activeProject$ = this.activeProjectSubject.asObservable();

  private openProjectsSubject = new BehaviorSubject<ProjectItem[]>([]);
  public openProjects$ = this.openProjectsSubject.asObservable();

  private projectsSubject = new BehaviorSubject<ProjectItem[]>([]);
  public projects$ = this.projectsSubject.asObservable();

  private masterUserSubject = new BehaviorSubject<MasterUser | null>(null);
  public masterUser$ = this.masterUserSubject.asObservable();

  private inProjectUserSubject = new BehaviorSubject<InProjectUser | null>(null);
  public inProjectUser$ = this.inProjectUserSubject.asObservable();

  constructor(private http: HttpClient) {
    this._restoreSession();
  }

  private _restoreSession(): void {
    try {
      const savedUser = localStorage.getItem('sutram_master_user');
      if (savedUser) {
        try {
          const u = JSON.parse(savedUser);
          if (u && u.username) {
            this.masterUserSubject.next(u);
          }
        } catch {}
      }
      const savedProjects = localStorage.getItem('sutram_cached_projects');
      if (savedProjects) {
        const pList = JSON.parse(savedProjects);
        if (Array.isArray(pList) && pList.length > 0) {
          this.projectsSubject.next(pList);
        }
      }
      const savedOpen = localStorage.getItem('sutram_open_projects');
      if (savedOpen) {
        const list = JSON.parse(savedOpen);
        if (Array.isArray(list) && list.length > 0) {
          this.openProjectsSubject.next(list);
        }
      }
      const savedProject = localStorage.getItem('sutram_active_project');
      if (savedProject) {
        const p = JSON.parse(savedProject);
        this.activeProjectSubject.next(p);
        const currentList = this.openProjectsSubject.value;
        if (!currentList.some(item => item.project_slug === p.project_slug)) {
          this.openProjectsSubject.next([...currentList, p]);
        }
      }

      // Safely schedule background async network calls outside the constructor
      setTimeout(() => {
        const currentActive = this.activeProject;
        if (currentActive) {
          this.http.post(`/api/_sutram/master/projects/switch/${encodeURIComponent(currentActive.project_slug)}`, {}).subscribe({
            next: () => console.log(`[ProjectContextService] Restored server active connection to "${currentActive.project_slug}"`),
            error: (err) => console.warn(`[ProjectContextService] Server restore error:`, err?.message || err)
          });
        }
        if (this.isAuthenticated) {
          this.loadProjects().subscribe();
        }
      }, 0);
    } catch (e) {
      console.warn('[ProjectContextService] Error restoring session:', e);
    }
  }

  public get isAuthenticated(): boolean {
    return !!this.masterUserSubject.value;
  }

  public get canCreateProject(): boolean {
    const u = this.masterUserSubject.value;
    if (!u) return false;
    if (u.role === 'superadmin' || u.username === 'admin') return true;
    return u.can_create_project === 1;
  }

  public get activeProject(): ProjectItem | null {
    return this.activeProjectSubject.value;
  }

  public get openProjects(): ProjectItem[] {
    return this.openProjectsSubject.value;
  }

  public get projects(): ProjectItem[] {
    return this.projectsSubject.value;
  }

  public get activeMasterUser(): MasterUser | null {
    return this.masterUserSubject.value;
  }

  public loginMasterUser(username: string, password: string): Observable<{ success: boolean; result?: MasterUser; error?: string }> {
    return this.http.post<{ success: boolean; result?: MasterUser; error?: string }>('/api/_sutram/master/login', { username, password }).pipe(
      tap(res => {
        if (res && res.success && res.result) {
          this.setMasterUser(res.result);
        }
      }),
      catchError(err => {
        const msg = err?.error?.error || err?.message || 'अमान्य यूज़रनेम या पासवर्ड (Login failed)';
        return of({ success: false, error: msg });
      })
    );
  }

  public logoutMasterUser(): void {
    localStorage.removeItem('sutram_master_user');
    this.masterUserSubject.next(null);
    this.closeAllProjects();
  }

  public get activeInProjectUser(): InProjectUser | null {
    return this.inProjectUserSubject.value;
  }

  public openProject(project: ProjectItem): void {
    const list = this.openProjectsSubject.value;
    const exists = list.find(p => p.project_slug === project.project_slug);
    if (!exists) {
      const updated = [...list, project];
      this.openProjectsSubject.next(updated);
      localStorage.setItem('sutram_open_projects', JSON.stringify(updated));
    }
    this.setActiveProject(project);
  }

  public closeProject(slug: string): void {
    const list = this.openProjectsSubject.value.filter(p => p.project_slug !== slug);
    this.openProjectsSubject.next(list);
    localStorage.setItem('sutram_open_projects', JSON.stringify(list));

    if (this.activeProject?.project_slug === slug) {
      if (list.length > 0) {
        this.setActiveProject(list[list.length - 1]);
      } else {
        this.setActiveProject(null);
      }
    }
  }

  public closeAllProjects(): void {
    this.openProjectsSubject.next([]);
    localStorage.removeItem('sutram_open_projects');
    this.setActiveProject(null);
  }

  public setActiveProject(project: ProjectItem | null): void {
    this.activeProjectSubject.next(project);
    if (project) {
      localStorage.setItem('sutram_active_project', JSON.stringify(project));
      const list = this.openProjectsSubject.value;
      if (!list.some(p => p.project_slug === project.project_slug)) {
        const updated = [...list, project];
        this.openProjectsSubject.next(updated);
        localStorage.setItem('sutram_open_projects', JSON.stringify(updated));
      }
      // Notify server immediately to switch active database connection
      this.http.post(`/api/_sutram/master/projects/switch/${encodeURIComponent(project.project_slug)}`, {}).subscribe({
        next: () => {
          console.log(`[ProjectContextService] Switched server active database to "${project.project_slug}"`);
        },
        error: (err) => {
          console.warn(`[ProjectContextService] Server switch error:`, err?.message || err);
        }
      });
      // Reset in-project user to default project admin
      this.inProjectUserSubject.next({
        _id: 1,
        username: 'admin',
        display_name: 'Project Admin',
        role: 'admin',
        active: 1
      });
    } else {
      localStorage.removeItem('sutram_active_project');
      this.inProjectUserSubject.next(null);
    }
  }

  public setMasterUser(user: MasterUser): void {
    this.masterUserSubject.next(user);
    localStorage.setItem('sutram_master_user', JSON.stringify(user));
    // Reload projects for this user
    this.loadProjects().subscribe();
  }

  public setInProjectUser(user: InProjectUser | null): void {
    this.inProjectUserSubject.next(user);
  }

  /**
   * Loads accessible projects from server
   */
  public loadProjects(): Observable<{ success: boolean; result: ProjectItem[] }> {
    if (!this.isAuthenticated) {
      this.projectsSubject.next([]);
      return of({ success: true, result: [] });
    }
    const username = this.activeMasterUser?.username || 'admin';
    return this.http.get<{ success: boolean; result: ProjectItem[] }>(`/api/_sutram/master/projects?username=${encodeURIComponent(username)}`).pipe(
      tap(res => {
        if (res && res.success && Array.isArray(res.result)) {
          this.projectsSubject.next(res.result);
          try {
            localStorage.setItem('sutram_cached_projects', JSON.stringify(res.result));
          } catch {}
          // If active project is open, refresh its metadata
          const current = this.activeProject;
          if (current) {
            const fresh = res.result.find(p => p.project_slug === current.project_slug);
            if (fresh) {
              this.activeProjectSubject.next(fresh);
            }
          }
        }
      }),
      catchError(err => {
        console.error('[ProjectContextService] loadProjects error:', err);
        return of({ success: false, result: [] });
      })
    );
  }

  /**
   * Uploads a temporary SQLite file for pre-flight inspection
   */
  public uploadDbTemp(file: File): Observable<{ success: boolean; tempFileKey: string; originalName: string; inspection: DbInspectionReport }> {
    const formData = new FormData();
    formData.append('dbFile', file, file.name);
    return this.http.post<{ success: boolean; tempFileKey: string; originalName: string; inspection: DbInspectionReport }>('/api/_sutram/master/projects/upload-db-temp', formData);
  }

  /**
   * Inspects a candidate database on server
   */
  public inspectDb(filePath: string): Observable<{ success: boolean; inspection: DbInspectionReport }> {
    return this.http.post<{ success: boolean; inspection: DbInspectionReport }>('/api/_sutram/master/projects/inspect-db', { filePath });
  }

  /**
   * Creates a new isolated project database or adopts an uploaded SQLite database
   */
  public createProject(payload: ProjectCreatePayload): Observable<{ success: boolean; result: ProjectItem; logs?: string[]; message?: string }> {
    const body = {
      ...payload,
      createdBy: this.activeMasterUser?.username || 'admin'
    };
    return this.http.post<{ success: boolean; result: ProjectItem; logs?: string[]; message?: string }>('/api/_sutram/master/projects', body).pipe(
      tap(res => {
        if (res && res.success && res.result) {
          // Refresh list and select the newly created project
          this.loadProjects().subscribe();
          this.setActiveProject(res.result);
        }
      })
    );
  }

  /**
   * Updates project details (name, description, color, icon)
   */
  public updateProject(slug: string, payload: Partial<ProjectItem>): Observable<{ success: boolean; result: ProjectItem }> {
    return this.http.put<{ success: boolean; result: ProjectItem }>(`/api/_sutram/master/projects/${slug}`, payload).pipe(
      tap(res => {
        if (res && res.success) {
          this.loadProjects().subscribe();
        }
      })
    );
  }

  /**
   * Archives / Deletes a project
   */
  public deleteProject(slug: string): Observable<{ success: boolean; message?: string }> {
    return this.http.delete<{ success: boolean; message?: string }>(`/api/_sutram/master/projects/${slug}`).pipe(
      tap(res => {
        if (res && res.success) {
          if (this.activeProject?.project_slug === slug) {
            this.setActiveProject(null);
          }
          this.loadProjects().subscribe();
        }
      })
    );
  }

  /**
   * Fetches master workspace users
   */
  public getMasterUsers(): Observable<MasterUser[]> {
    return this.http.get<{ success: boolean; result: MasterUser[] }>('/api/_sutram/master/users').pipe(
      map(res => (res && res.success && Array.isArray(res.result)) ? res.result : []),
      catchError(err => {
        console.error('[ProjectContextService] getMasterUsers error:', err);
        return of([] as MasterUser[]);
      })
    );
  }

  /**
   * Creates a new master user
   */
  public createMasterUser(payload: { username: string; password: string; display_name: string; role: string; can_create_project?: number }): Observable<any> {
    return this.http.post('/api/_sutram/master/users', payload);
  }

  /**
   * Updates existing master user
   */
  public updateMasterUser(userId: number, payload: Partial<MasterUser> & { password?: string }): Observable<any> {
    return this.http.put(`/api/_sutram/master/users/${userId}`, payload);
  }

  /**
   * Get project members / access list
   */
  public getProjectAccess(slug: string): Observable<ProjectMember[]> {
    return this.http.get<{ success: boolean; result: ProjectMember[] }>(`/api/_sutram/master/projects/${slug}/access`).pipe(
      map(res => (res && res.success && Array.isArray(res.result)) ? res.result : []),
      catchError(err => {
        console.error('[ProjectContextService] getProjectAccess error:', err);
        return of([] as ProjectMember[]);
      })
    );
  }

  /**
   * Get list of projects accessible to a user
   */
  public getUserProjects(userId: number): Observable<Array<{ project_id: number; project_name: string; project_slug: string; access_role: string }>> {
    return this.http.get<{ success: boolean; result: any[] }>(`/api/_sutram/master/users/${userId}/projects`).pipe(
      map(res => (res && res.success && Array.isArray(res.result)) ? res.result : []),
      catchError(err => {
        console.error('[ProjectContextService] getUserProjects error:', err);
        return of([]);
      })
    );
  }

  /**
   * Grant project access to a master user
   */
  public grantProjectAccess(slug: string, userId: number, accessRole: string = 'member'): Observable<any> {
    return this.http.post(`/api/_sutram/master/projects/${slug}/access`, { userId, accessRole });
  }

  /**
   * Revoke project access
   */
  public revokeProjectAccess(slug: string, userId: number): Observable<any> {
    return this.http.delete(`/api/_sutram/master/projects/${slug}/access/${userId}`);
  }
}

