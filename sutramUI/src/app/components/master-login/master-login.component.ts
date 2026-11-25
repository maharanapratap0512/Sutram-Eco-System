import { Component, Input, Output, EventEmitter, ChangeDetectorRef } from '@angular/core';
import { ProjectContextService } from '../../services/project-context.service';
import { MasterUser } from '../../models/project.model';

@Component({
  selector: 'app-master-login',
  templateUrl: './master-login.component.html',
  styleUrls: ['./master-login.component.scss']
})
export class MasterLoginComponent {
  @Input() isDarkMode: boolean = false;
  @Output() loginSuccess = new EventEmitter<MasterUser>();
  @Output() toggleTheme = new EventEmitter<void>();

  public username: string = '';
  public password: string = '';
  public isLoading: boolean = false;
  public errorMessage: string = '';

  constructor(
    private projectContext: ProjectContextService,
    private cdr: ChangeDetectorRef
  ) {}

  public onLogin(): void {
    if (!this.username?.trim()) {
      this.errorMessage = 'Please enter username';
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';

    this.projectContext.loginMasterUser(this.username.trim(), (this.password ?? '').trim()).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res && res.success && res.result) {
          this.loginSuccess.emit(res.result);
        } else {
          this.errorMessage = res?.error || 'Invalid username or password';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err?.error?.error || err?.message || 'Connection failed';
        this.cdr.markForCheck();
      }
    });
  }

  public fillDemoAdmin(): void {
    this.username = 'admin';
    this.password = 'sutram';
    this.errorMessage = '';
  }
}

