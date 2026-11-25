/**
 * project.interceptor.ts
 * ─────────────────────────────────────────────────────────────
 * Transparently attaches active project context (x-project-slug),
 * Master auth token (x-master-token), Project auth token (x-project-token),
 * LAN token (x-lan-token), and Unmask tokens (x-unmask-tokens)
 * using browser-tab / window-scoped sessionStorage.
 * ─────────────────────────────────────────────────────────────
 */

import { Injectable, Injector } from '@angular/core';
import {
  HttpRequest,
  HttpHandler,
  HttpEvent,
  HttpInterceptor,
  HttpErrorResponse
} from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ProjectContextService } from '../services/project-context.service';

@Injectable()
export class ProjectHttpInterceptor implements HttpInterceptor {
  private projectService?: ProjectContextService;

  constructor(private injector: Injector) {}

  private getProjectService(): ProjectContextService | null {
    if (!this.projectService) {
      try {
        this.projectService = this.injector.get(ProjectContextService);
      } catch {}
    }
    return this.projectService || null;
  }

  intercept(request: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    let activeSlug: string | undefined;
    let masterUsername: string | undefined;
    let masterToken: string | undefined;
    let projectToken: string | undefined;
    let lanToken: string | undefined;
    let unmaskTokens: string[] = [];

    const svc = this.getProjectService();
    if (svc) {
      activeSlug = svc.activeProject?.project_slug;
      masterUsername = svc.activeMasterUser?.username;
      masterToken = svc.getMasterToken();
      lanToken = svc.getLanToken();
      if (activeSlug) {
        projectToken = svc.getProjectToken(activeSlug);
        unmaskTokens = svc.getUnmaskTokens(activeSlug);
      }
    }

    if (!activeSlug) {
      try {
        const raw = sessionStorage.getItem('sutram_active_project');
        if (raw) {
          activeSlug = JSON.parse(raw)?.project_slug;
        }
      } catch {}
    }

    if (!masterUsername) {
      try {
        const rawU = sessionStorage.getItem('sutram_master_user');
        if (rawU) {
          masterUsername = JSON.parse(rawU)?.username;
        }
      } catch {}
    }

    if (!masterToken) {
      try {
        masterToken = sessionStorage.getItem('sutram_master_token') || '';
      } catch {}
    }

    if (!lanToken) {
      try {
        lanToken = sessionStorage.getItem('sutram_lan_token') || '';
      } catch {}
    }

    const requestSlug = request.headers.get('x-project-slug') || activeSlug;
    if (!projectToken && requestSlug) {
      try {
        const rawSessions = sessionStorage.getItem('sutram_project_sessions');
        if (rawSessions) {
          const parsed = JSON.parse(rawSessions);
          projectToken = parsed?.[requestSlug]?.token || '';
        }
      } catch {}
    }

    if (unmaskTokens.length === 0 && requestSlug) {
      try {
        const rawUnmask = sessionStorage.getItem('sutram_project_unmask_tokens');
        if (rawUnmask) {
          const parsed = JSON.parse(rawUnmask);
          const arr = parsed?.[requestSlug];
          if (Array.isArray(arr)) unmaskTokens = arr;
        }
      } catch {}
    }

    let headers = request.headers;

    if (requestSlug && !headers.has('x-project-slug')) {
      headers = headers.set('x-project-slug', requestSlug);
    }

    if (masterUsername && !headers.has('x-master-user')) {
      headers = headers.set('x-master-user', masterUsername);
    }

    if (masterToken && !headers.has('x-master-token')) {
      headers = headers.set('x-master-token', masterToken);
    }

    if (lanToken && !headers.has('x-lan-token')) {
      headers = headers.set('x-lan-token', lanToken);
    }

    const isProjectLoginCall = request.url.includes('/_sutram/auth/login');
    if (projectToken && !isProjectLoginCall && !headers.has('x-project-token')) {
      headers = headers.set('x-project-token', projectToken);
    }

    if (unmaskTokens.length > 0 && !headers.has('x-unmask-tokens')) {
      headers = headers.set('x-unmask-tokens', unmaskTokens.join(','));
    }

    // Rewrite relative API / Sutram URLs to local Node server when running inside Tauri / desktop webview
    let targetUrl = request.url;
    const isDesktopOrTauri = typeof window !== 'undefined' && (
      !!(window as any).__TAURI_INTERNALS__ ||
      !!(window as any).__TAURI__ ||
      window.location.protocol === 'tauri:' ||
      window.location.hostname === 'tauri.localhost' ||
      window.location.origin.includes('tauri') ||
      (window.location.port !== '3300' && window.location.port !== '4300')
    );

    if (isDesktopOrTauri && (targetUrl.startsWith('/api') || targetUrl.startsWith('/_sutram'))) {
      const apiHost = (localStorage.getItem('sutram_backend_url') || 'http://localhost:3300').replace(/\/$/, '');
      targetUrl = `${apiHost}${targetUrl}`;
    }

    const modifiedReq = request.clone({ url: targetUrl, headers });
    return next.handle(modifiedReq).pipe(
      catchError((err: HttpErrorResponse) => {
        if (err && err.status === 401 && svc) {
          const code = String(err.error?.code || '');
          const isMasterLogin = targetUrl.includes('/_sutram/master/login');
          const isUnmaskVerify = targetUrl.includes('/_sutram/auth/verify-unmask');
          if (code.startsWith('MASTER_') && !isMasterLogin && !isProjectLoginCall) {
            svc.logoutMasterUser();
          } else if (code.startsWith('PROJECT_') && requestSlug && !isProjectLoginCall && !isUnmaskVerify) {
            svc.clearProjectAuth(requestSlug);
          }
        }
        return throwError(() => err);
      })
    );
  }
}

