import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';
import { LanNetworkService, LanNodeInfo, LanPeer } from '../../services/lan-network.service';
import { ProjectContextService } from '../../services/project-context.service';
import { ProjectItem } from '../../models/project.model';

@Component({
  selector: 'app-lan-network-dialog',
  templateUrl: './lan-network-dialog.component.html',
  styleUrls: ['./lan-network-dialog.component.scss']
})
export class LanNetworkDialogComponent implements OnInit, OnDestroy {
  @Input() visible: boolean = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Input() isDarkMode: boolean = false;

  public activeTab: 'this_pc' | 'network' = 'this_pc';
  public localNode: LanNodeInfo | null = null;
  public peers: LanPeer[] = [];
  public projects: ProjectItem[] = [];

  // Sharing configuration state
  public sharingTargetProject: ProjectItem | null = null;
  public shareAuthType: 'none' | 'pin' | 'password' = 'pin';
  public sharePin: string = '1234';
  public sharePassword: string = '';
  public isSubmittingShare: boolean = false;
  public shareError: string = '';

  // Remote authentication challenge modal
  public isAuthModalOpen: boolean = false;
  public selectedRemotePeer: LanPeer | null = null;
  public selectedRemoteProject: any = null;
  public authChallenge: string = '';
  public authSecretInput: string = '';
  public authError: string = '';
  public isAuthenticating: boolean = false;

  private subs: Subscription[] = [];

  constructor(
    public lanService: LanNetworkService,
    public projectContext: ProjectContextService
  ) {}

  ngOnInit(): void {
    this.subs.push(
      this.lanService.localNode$.subscribe(node => this.localNode = node),
      this.lanService.peers$.subscribe(peers => this.peers = peers),
      this.projectContext.projects$.subscribe(projs => this.projects = projs)
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  public close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  public isProjectLive(projectId: string): boolean {
    if (!this.localNode || !this.localNode.projects) return false;
    return this.localNode.projects.some(p => p.id === projectId);
  }

  public getLiveProjectInfo(projectId: string): any {
    if (!this.localNode || !this.localNode.projects) return null;
    return this.localNode.projects.find(p => p.id === projectId) || null;
  }

  public promptShareProject(project: ProjectItem): void {
    this.sharingTargetProject = project;
    this.shareAuthType = 'pin';
    this.sharePin = '1234';
    this.sharePassword = '';
    this.shareError = '';
  }

  public cancelSharePrompt(): void {
    this.sharingTargetProject = null;
    this.shareError = '';
  }

  public confirmShareProject(): void {
    if (!this.sharingTargetProject) return;

    const cleanPin = (this.sharePin ?? '').trim();
    const cleanPass = (this.sharePassword ?? '').trim();
    const effectiveAuthType: 'none' | 'pin' | 'password' =
      this.shareAuthType === 'pin'
        ? (cleanPin ? 'pin' : 'none')
        : (this.shareAuthType === 'password' ? (cleanPass ? 'password' : 'none') : 'none');

    this.isSubmittingShare = true;
    this.shareError = '';

    this.lanService.shareProject({
      projectId: this.sharingTargetProject.project_slug,
      name: this.sharingTargetProject.project_name,
      authType: effectiveAuthType,
      pin: effectiveAuthType === 'pin' ? cleanPin : undefined,
      password: effectiveAuthType === 'password' ? cleanPass : undefined,
      description: this.sharingTargetProject.description || ''
    }).subscribe({
      next: (res) => {
        this.isSubmittingShare = false;
        if (res.success) {
          this.sharingTargetProject = null;
        } else {
          this.shareError = res.error || 'Failed to share project on LAN';
        }
      },
      error: (err) => {
        this.isSubmittingShare = false;
        this.shareError = err?.error?.error || err.message || 'Network error while sharing project';
      }
    });
  }

  public unshareProject(projectId: string): void {
    this.lanService.unshareProject(projectId).subscribe();
  }

  public onConnectToPeerProject(peer: LanPeer, remoteProj: any): void {
    this.selectedRemotePeer = peer;
    this.selectedRemoteProject = remoteProj;
    this.authError = '';
    this.authSecretInput = '';

    const remoteBaseUrl = `http://${peer.ip}:${peer.httpPort || 3300}`;

    if (remoteProj.authType === 'none') {
      // Direct connect
      this.openRemoteProject(remoteBaseUrl, remoteProj.id);
      return;
    }

    // Auth challenge required
    this.isAuthenticating = true;
    this.lanService.requestChallenge(remoteProj.id, remoteBaseUrl).subscribe({
      next: (res) => {
        this.isAuthenticating = false;
        if (res.success && res.challenge) {
          this.authChallenge = res.challenge;
          this.isAuthModalOpen = true;
        } else {
          this.authError = res.error || 'Could not initiate authentication challenge with remote peer';
        }
      },
      error: (err) => {
        this.isAuthenticating = false;
        this.authError = `Cannot connect to ${peer.name} (${remoteBaseUrl}): ${err.message || 'Peer unreachable'}`;
      }
    });
  }

  public submitAuthChallenge(): void {
    if (!this.selectedRemotePeer || !this.selectedRemoteProject || !this.authChallenge) return;

    if (!this.authSecretInput || this.authSecretInput.trim().length === 0) {
      this.authError = 'Please enter PIN or password';
      return;
    }

    this.isAuthenticating = true;
    this.authError = '';

    const remoteBaseUrl = `http://${this.selectedRemotePeer.ip}:${this.selectedRemotePeer.httpPort || 3300}`;

    this.lanService.authenticate(this.authChallenge, this.authSecretInput.trim(), remoteBaseUrl).subscribe({
      next: (res) => {
        this.isAuthenticating = false;
        if (res.success && res.token) {
          this.isAuthModalOpen = false;
          this.openRemoteProject(remoteBaseUrl, this.selectedRemoteProject.id, res.token);
        } else {
          this.authError = res.error || 'Invalid PIN or password';
        }
      },
      error: (err) => {
        this.isAuthenticating = false;
        this.authError = err?.error?.error || 'Authentication failed';
      }
    });
  }

  private openRemoteProject(remoteBaseUrl: string, projectId: string, token?: string): void {
    const tokenParam = token ? `&lanToken=${encodeURIComponent(token)}` : '';
    const targetUrl = `${remoteBaseUrl}/#project=${encodeURIComponent(projectId)}${tokenParam}`;
    window.open(targetUrl, '_blank');
  }
}
