/**
 * project.interceptor.ts
 * ─────────────────────────────────────────────────────────────
 * Transparently attaches active project context (x-project-slug)
 * and active master user (x-master-user) to all outgoing HTTP requests.
 * ─────────────────────────────────────────────────────────────
 */

import { Injectable, Injector } from '@angular/core';
import { HttpRequest, HttpHandler, HttpEvent, HttpInterceptor } from '@angular/common/http';
import { Observable } from 'rxjs';
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

    const svc = this.getProjectService();
    if (svc) {
      activeSlug = svc.activeProject?.project_slug;
      masterUsername = svc.activeMasterUser?.username;
    }

    if (!activeSlug) {
      try {
        const raw = localStorage.getItem('sutram_active_project');
        if (raw) {
          activeSlug = JSON.parse(raw)?.project_slug;
        }
      } catch {}
    }

    if (!masterUsername) {
      try {
        const rawU = localStorage.getItem('sutram_master_user');
        if (rawU) {
          masterUsername = JSON.parse(rawU)?.username;
        }
      } catch {}
    }

    let headers = request.headers;

    if (activeSlug && !headers.has('x-project-slug')) {
      headers = headers.set('x-project-slug', activeSlug);
    }

    if (masterUsername && !headers.has('x-master-user')) {
      headers = headers.set('x-master-user', masterUsername);
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
    return next.handle(modifiedReq);
  }
}

