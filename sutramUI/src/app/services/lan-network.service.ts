import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, catchError, of, tap } from 'rxjs';

export interface LanNodeInfo {
  nodeId: string;
  name: string;
  hostname: string;
  port: number;
  ip: string;
  projectsCount: number;
  projects: Array<{
    id: string;
    name: string;
    authType: 'none' | 'pin' | 'password';
    tablesCount?: number;
    description?: string;
  }>;
}

export interface LanPeer {
  nodeId: string;
  name: string;
  hostname: string;
  port: number;
  ip: string;
  httpPort: number;
  projectsCount: number;
  projects: Array<{
    id: string;
    name: string;
    authType: 'none' | 'pin' | 'password';
    tablesCount?: number;
    description?: string;
  }>;
  lastSeen: number;
  ageSeconds: number;
}

export interface LanStatusResponse {
  success: boolean;
  node: LanNodeInfo;
  peersCount: number;
  peers: LanPeer[];
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class LanNetworkService {
  private localNodeSubject = new BehaviorSubject<LanNodeInfo | null>(null);
  public localNode$ = this.localNodeSubject.asObservable();

  private peersSubject = new BehaviorSubject<LanPeer[]>([]);
  public peers$ = this.peersSubject.asObservable();

  private peerCountSubject = new BehaviorSubject<number>(0);
  public peerCount$ = this.peerCountSubject.asObservable();

  private refreshTimer: any = null;

  constructor(private http: HttpClient) {
    this.startPeriodicScan();
  }

  public startPeriodicScan(intervalMs: number = 4000): void {
    this.refreshStatus();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.refreshStatus();
    }, intervalMs);
  }

  public stopPeriodicScan(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public refreshStatus(): Observable<LanStatusResponse | null> {
    return this.http.get<LanStatusResponse>('/api/_sutram/lan/status').pipe(
      tap((res) => {
        if (res && res.success) {
          if (res.node) this.localNodeSubject.next(res.node);
          if (Array.isArray(res.peers)) {
            this.peersSubject.next(res.peers);
            this.peerCountSubject.next(res.peers.length);
          }
        }
      }),
      catchError(() => of(null))
    );
  }

  public shareProject(payload: {
    projectId: string;
    name?: string;
    authType?: 'none' | 'pin' | 'password';
    pin?: string;
    password?: string;
    description?: string;
  }): Observable<{ success: boolean; message?: string; isLive?: boolean; error?: string }> {
    return this.http.post<{ success: boolean; message?: string; isLive?: boolean; error?: string }>(
      '/api/_sutram/lan/share',
      payload
    ).pipe(
      tap(() => this.refreshStatus().subscribe())
    );
  }

  public unshareProject(projectId: string): Observable<{ success: boolean; message?: string; isLive?: boolean; error?: string }> {
    return this.http.post<{ success: boolean; message?: string; isLive?: boolean; error?: string }>(
      '/api/_sutram/lan/unshare',
      { projectId }
    ).pipe(
      tap(() => this.refreshStatus().subscribe())
    );
  }

  public requestChallenge(projectId: string, remoteHost?: string): Observable<{ success: boolean; challenge?: string; authType?: string; salt?: string; error?: string }> {
    const url = remoteHost ? `${remoteHost}/api/_sutram/lan/challenge` : '/api/_sutram/lan/challenge';
    return this.http.post<{ success: boolean; challenge?: string; authType?: string; salt?: string; error?: string }>(
      url,
      { projectId }
    );
  }

  public authenticate(challenge: string, secret: string, remoteHost?: string): Observable<{ success: boolean; token?: string; error?: string }> {
    const url = remoteHost ? `${remoteHost}/api/_sutram/lan/auth` : '/api/_sutram/lan/auth';
    return this.http.post<{ success: boolean; token?: string; error?: string }>(
      url,
      { challenge, secret }
    );
  }
}
