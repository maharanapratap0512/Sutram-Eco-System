/**
 * project-context.service.ts
 * ─────────────────────────────────────────────────────────────
 * Central State & API Service for Sutram Projects Hub & Workspaces.
 * ─────────────────────────────────────────────────────────────
 */

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, map, tap, catchError, of, throwError } from 'rxjs';
import {
  ProjectItem,
  MasterUser,
  InProjectUser,
  ProjectCreatePayload,
  ProjectMember,
  DbInspectionReport,
  MySqlDatabaseItem,
  ProjectTableRight,
  ProjectSessionState
} from '../models/project.model';

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

  private masterTokenValue: string = '';
  private lanTokenValue: string = '';
  private pendingLanProjectSlug: string = '';
  private projectSessionsMap: { [slug: string]: ProjectSessionState } = {};
  private projectUnmaskTokensMap: { [slug: string]: string[] } = {};

  constructor(private http: HttpClient) {
    this._restoreSession();
  }

  private _purgeLegacyLocalAuth(): void {
    try {
      const legacyKeys = [
        'sutram_master_user',
        'sutram_master_token',
        'sutram_open_projects',
        'sutram_active_project',
        'sutram_active_user',
        'sutram_cached_projects'
      ];
      for (const k of legacyKeys) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  private _persistProjectSessions(): void {
    try {
      sessionStorage.setItem('sutram_project_sessions', JSON.stringify(this.projectSessionsMap));
    } catch {}
  }

  private _persistUnmaskTokens(): void {
    try {
      sessionStorage.setItem('sutram_project_unmask_tokens', JSON.stringify(this.projectUnmaskTokensMap));
    } catch {}
  }

  private _restoreSession(): void {
    try {
      // Never auto-restore credentials from permanent localStorage (window close must force login)
      this._purgeLegacyLocalAuth();

      // Parse optional LAN direct link hash: #project=<slug>&lanToken=<token>
      if (typeof window !== 'undefined' && window.location.hash) {
        const hashStr = window.location.hash.replace(/^#/, '');
        const params = new URLSearchParams(hashStr);
        const hashProj = (params.get('project') || '').trim();
        const hashLanToken = (params.get('lanToken') || '').trim();
        if (hashProj) {
          this.pendingLanProjectSlug = hashProj;
        }
        if (hashLanToken) {
          this.lanTokenValue = hashLanToken;
          sessionStorage.setItem('sutram_lan_token', hashLanToken);
          // Scrub sensitive token from URL bar cleanly
          try {
            window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#project=${encodeURIComponent(hashProj)}`);
          } catch {}
        }
      }

      if (!this.lanTokenValue) {
        this.lanTokenValue = sessionStorage.getItem('sutram_lan_token') || '';
      }

      const savedToken = sessionStorage.getItem('sutram_master_token') || '';
      const savedUser = sessionStorage.getItem('sutram_master_user');
      if (savedUser && savedToken) {
        try {
          const u = JSON.parse(savedUser);
          if (u && u.username) {
            this.masterTokenValue = savedToken;
            this.masterUserSubject.next(u);
          }
        } catch {}
      }

      const savedSessions = sessionStorage.getItem('sutram_project_sessions');
      if (savedSessions) {
        try {
          const parsed = JSON.parse(savedSessions);
          if (parsed && typeof parsed === 'object') {
            this.projectSessionsMap = parsed;
          }
        } catch {}
      }

      const savedUnmask = sessionStorage.getItem('sutram_project_unmask_tokens');
      if (savedUnmask) {
        try {
          const parsed = JSON.parse(savedUnmask);
          if (parsed && typeof parsed === 'object') {
            this.projectUnmaskTokensMap = parsed;
          }
        } catch {}
      }

      const savedOpen = sessionStorage.getItem('sutram_open_projects');
      if (savedOpen) {
        const list = JSON.parse(savedOpen);
        if (Array.isArray(list) && list.length > 0) {
          this.openProjectsSubject.next(list);
        }
      }

      const savedProject = sessionStorage.getItem('sutram_active_project');
      if (savedProject) {
        const p = JSON.parse(savedProject);
        if (p && p.project_slug) {
          this.activeProjectSubject.next(p);
          const currentList = this.openProjectsSubject.value;
          if (!currentList.some(item => item.project_slug === p.project_slug)) {
            this.openProjectsSubject.next([...currentList, p]);
          }
          const sess = this.projectSessionsMap[p.project_slug];
          this.inProjectUserSubject.next(sess?.user || null);
        }
      }

      // Safely verify master/project session outside constructor
      setTimeout(() => {
        if (this.masterTokenValue) {
          this.http.get<{ success: boolean; result?: MasterUser }>('/api/_sutram/master/me').subscribe({
            next: (res) => {
              if (res && res.success && res.result) {
                this.masterUserSubject.next({ ...res.result, token: this.masterTokenValue });
                sessionStorage.setItem('sutram_master_user', JSON.stringify(this.masterUserSubject.value));
                this.loadProjects().subscribe({
                  next: (pRes) => {
                    if (this.pendingLanProjectSlug && pRes?.result) {
                      const targetProj = pRes.result.find(item => item.project_slug === this.pendingLanProjectSlug);
                      if (targetProj) this.openProject(targetProj);
                    }
                  }
                });
              } else {
                this.logoutMasterUser();
              }
            },
            error: () => {
              this.logoutMasterUser();
            }
          });
        } else if (this.pendingLanProjectSlug) {
          // Remote LAN direct project entry (via x-lan-token or open LAN share)
          this.http.get<{ success: boolean; result?: ProjectItem }>(
            `/api/_sutram/master/projects/${encodeURIComponent(this.pendingLanProjectSlug)}`
          ).subscribe({
            next: (res) => {
              if (res && res.success && res.result) {
                this.openProject(res.result);
              }
            },
            error: (err) => console.warn('[ProjectContextService] LAN project fetch error:', err?.message || err)
          });
        }

        const currentActive = this.activeProject;
        if (currentActive && this.isProjectAuthenticated(currentActive.project_slug)) {
          this.http.post(`/api/_sutram/master/projects/switch/${encodeURIComponent(currentActive.project_slug)}`, {}).subscribe({
            error: (err) => console.warn(`[ProjectContextService] Server restore error:`, err?.message || err)
          });
        }
      }, 0);
    } catch (e) {
      console.warn('[ProjectContextService] Error restoring session:', e);
    }
  }

  public get isAuthenticated(): boolean {
    if (this.masterUserSubject.value && this.masterTokenValue) return true;
    // Allow direct LAN shared workspace access cleanly when launched via LAN peer link
    if ((this.lanTokenValue || this.pendingLanProjectSlug) && this.activeProjectSubject.value) {
      return true;
    }
    return false;
  }

  public getMasterToken(): string {
    return this.masterTokenValue || sessionStorage.getItem('sutram_master_token') || '';
  }

  public getLanToken(): string {
    return this.lanTokenValue || sessionStorage.getItem('sutram_lan_token') || '';
  }

  public getProjectSession(slug?: string | null): ProjectSessionState | null {
    if (!slug) return null;
    if (this.projectSessionsMap[slug]) return this.projectSessionsMap[slug];
    try {
      const raw = sessionStorage.getItem('sutram_project_sessions');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed[slug]) {
          this.projectSessionsMap = parsed;
          return parsed[slug];
        }
      }
    } catch {}
    return null;
  }

  public isProjectAuthenticated(slug?: string | null): boolean {
    const sess = this.getProjectSession(slug);
    return !!(sess && sess.token && sess.user);
  }

  public getProjectToken(slug?: string | null): string {
    return this.getProjectSession(slug)?.token || '';
  }

  public setProjectSession(slug: string, session: ProjectSessionState): void {
    if (!slug) return;
    this.projectSessionsMap[slug] = {
      ...session,
      projectSlug: slug
    };
    this._persistProjectSessions();
    if (this.activeProject?.project_slug === slug) {
      this.inProjectUserSubject.next(session.user || null);
    }
  }

  public clearProjectAuth(slug?: string | null): void {
    if (!slug) return;
    delete this.projectSessionsMap[slug];
    this._persistProjectSessions();
    this.clearUnmaskTokens(slug);
    if (this.activeProject?.project_slug === slug) {
      this.inProjectUserSubject.next(null);
    }
  }

  public addUnmaskToken(slug: string, token: string): void {
    if (!slug || !token) return;
    const list = this.getUnmaskTokens(slug);
    if (!list.includes(token)) {
      this.projectUnmaskTokensMap[slug] = [...list, token];
      this._persistUnmaskTokens();
    }
  }

  public getUnmaskTokens(slug?: string | null): string[] {
    if (!slug) return [];
    if (Array.isArray(this.projectUnmaskTokensMap[slug])) return this.projectUnmaskTokensMap[slug];
    try {
      const raw = sessionStorage.getItem('sutram_project_unmask_tokens');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed[slug])) {
          this.projectUnmaskTokensMap = parsed;
          return parsed[slug];
        }
      }
    } catch {}
    return [];
  }

  public clearUnmaskTokens(slug?: string | null): void {
    if (!slug) return;
    delete this.projectUnmaskTokensMap[slug];
    this._persistUnmaskTokens();
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
        const msg = err?.error?.error || err?.message || 'Invalid username or password (Login failed)';
        return of({ success: false, error: msg });
      })
    );
  }

  public logoutMasterUser(): void {
    this.masterTokenValue = '';
    this.lanTokenValue = '';
    this.pendingLanProjectSlug = '';
    try {
      sessionStorage.removeItem('sutram_master_user');
      sessionStorage.removeItem('sutram_master_token');
      sessionStorage.removeItem('sutram_lan_token');
    } catch {}
    this._purgeLegacyLocalAuth();
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
      try {
        sessionStorage.setItem('sutram_open_projects', JSON.stringify(updated));
      } catch {}
    }
    this.setActiveProject(project);
  }

  public closeProject(slug: string): void {
    const list = this.openProjectsSubject.value.filter(p => p.project_slug !== slug);
    this.openProjectsSubject.next(list);
    try {
      sessionStorage.setItem('sutram_open_projects', JSON.stringify(list));
    } catch {}

    // Closing a project locks it so reopening asks for its project password again
    this.clearProjectAuth(slug);

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
    this.projectSessionsMap = {};
    this._persistProjectSessions();
    this.projectUnmaskTokensMap = {};
    this._persistUnmaskTokens();
    try {
      sessionStorage.removeItem('sutram_open_projects');
    } catch {}
    this.setActiveProject(null);
  }

  public setActiveProject(project: ProjectItem | null): void {
    this.activeProjectSubject.next(project);
    if (project) {
      try {
        sessionStorage.setItem('sutram_active_project', JSON.stringify(project));
      } catch {}
      const list = this.openProjectsSubject.value;
      if (!list.some(p => p.project_slug === project.project_slug)) {
        const updated = [...list, project];
        this.openProjectsSubject.next(updated);
        try {
          sessionStorage.setItem('sutram_open_projects', JSON.stringify(updated));
        } catch {}
      }
      // Notify server to sync active database slug context if authenticated
      this.http.post(`/api/_sutram/master/projects/switch/${encodeURIComponent(project.project_slug)}`, {}).subscribe({
        next: () => {
          console.log(`[ProjectContextService] Switched server active database to "${project.project_slug}"`);
        },
        error: (err) => {
          console.warn(`[ProjectContextService] Server switch error:`, err?.message || err);
        }
      });
      // Sync strictly from per-project verified session (never auto-admin!)
      const existingSess = this.getProjectSession(project.project_slug);
      this.inProjectUserSubject.next(existingSess?.user || null);
    } else {
      try {
        sessionStorage.removeItem('sutram_active_project');
      } catch {}
      this.inProjectUserSubject.next(null);
    }
  }

  public setMasterUser(user: MasterUser): void {
    this.masterTokenValue = user?.token || this.masterTokenValue || '';
    this.masterUserSubject.next(user);
    try {
      if (this.masterTokenValue) {
        sessionStorage.setItem('sutram_master_token', this.masterTokenValue);
      }
      sessionStorage.setItem('sutram_master_user', JSON.stringify(user));
    } catch {}
    // Reload projects for this user
    this.loadProjects().subscribe({
      next: (pRes) => {
        if (this.pendingLanProjectSlug && pRes?.result) {
          const targetProj = pRes.result.find(item => item.project_slug === this.pendingLanProjectSlug);
          if (targetProj) this.openProject(targetProj);
        }
      }
    });
  }

  public setInProjectUser(user: InProjectUser | null): void {
    this.inProjectUserSubject.next(user);
  }

  /**
   * Loads accessible projects from server
   */
  public loadProjects(): Observable<{ success: boolean; result: ProjectItem[] }> {
    if (!this.masterUserSubject.value || !this.masterTokenValue) {
      this.projectsSubject.next([]);
      return of({ success: true, result: [] });
    }
    const username = this.activeMasterUser?.username || 'admin';
    return this.http.get<{ success: boolean; result: ProjectItem[] }>(`/api/_sutram/master/projects?username=${encodeURIComponent(username)}`).pipe(
      tap(res => {
        if (res && res.success && Array.isArray(res.result)) {
          this.projectsSubject.next(res.result);
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
   * Auto-discovers databases on a MySQL server
   */
  public listMySqlDatabases(config: { host: string; port?: number; user: string; password?: string }): Observable<{ success: boolean; result: MySqlDatabaseItem[] }> {
    return this.http.post<{ success: boolean; result: MySqlDatabaseItem[] }>('/api/_sutram/master/projects/mysql/databases', config);
  }

  /**
   * Pre-flight schema inspection of a target MySQL database
   */
  public inspectMySqlDatabase(config: { host: string; port?: number; user: string; password?: string; database: string }): Observable<{ success: boolean; result: DbInspectionReport }> {
    return this.http.post<{ success: boolean; result: DbInspectionReport }>('/api/_sutram/master/projects/mysql/inspect', config);
  }

  /**
   * Archives / Deletes a project, optionally running a zero-trace purge of Sutram metadata
   */
  public deleteProject(slug: string, purge: boolean = false): Observable<{ success: boolean; message?: string }> {
    return this.http.delete<{ success: boolean; message?: string }>(`/api/_sutram/master/projects/${slug}?purge=${purge}`).pipe(
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

  /**
   * Emergency Reset Application State & Local Caches.
   * Completely clears localStorage, sessionStorage, active projects, tokens, and in-memory subjects,
   * cleanly escaping any locked dialogs, stale keys, or corrupted states without touching physical DB files.
   */
  public emergencyResetAppState(hardReload: boolean = true): void {
    try {
      const savedTheme = localStorage.getItem('sutram_dark_mode');
      localStorage.clear();
      sessionStorage.clear();
      if (savedTheme) {
        localStorage.setItem('sutram_dark_mode', savedTheme);
      }
    } catch (e) {
      console.warn('[ProjectContextService] emergencyResetAppState storage clear error:', e);
    }

    this.masterTokenValue = '';
    this.lanTokenValue = '';
    this.pendingLanProjectSlug = '';
    this.projectSessionsMap = {};
    this.projectUnmaskTokensMap = {};

    this.activeProjectSubject.next(null);
    this.openProjectsSubject.next([]);
    this.masterUserSubject.next(null);
    this.inProjectUserSubject.next(null);
    this.projectsSubject.next([]);

    if (hardReload && typeof window !== 'undefined') {
      window.location.href = window.location.origin + window.location.pathname;
    }
  }
}

