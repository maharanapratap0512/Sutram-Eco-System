/**
 * sutram-auth-dialog.component.ts
 * ─────────────────────────────────────────────────────────────
 * Autonomous, Universal Authentication Dialog for Sutram Excel Studio.
 * Complies with Rule 14 (Subcomponent Separation), Rule 15 (PrimeNG First),
 * and Rule 21 (Dark Mode Protection).
 * ─────────────────────────────────────────────────────────────
 */

import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Component({
  selector: 'sutram-auth-dialog',
  templateUrl: './sutram-auth-dialog.component.html',
  styleUrls: ['./sutram-auth-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SutramAuthDialogComponent {
  @Input() visible: boolean = false;
  @Input() isDarkMode: boolean = false;
  @Input() apiBase: string = '/_sutram/excel';
  @Input() projectSlug: string = '';
  @Input() title: string = 'Sutram Project Authentication';
  @Input() canDismiss: boolean = true;

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() authenticated = new EventEmitter<{ user: any; rights: any[]; token?: string }>();

  public username: string = '';
  public password: string = '';
  public errorMessage: string = '';
  public isLoading: boolean = false;

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef
  ) {}

  public close(): void {
    if (!this.canDismiss) return;
    this.visible = false;
    this.visibleChange.emit(false);
    this.errorMessage = '';
    this.password = '';
  }

  public onSubmit(): void {
    this.errorMessage = '';
    if (!this.username.trim()) {
      this.errorMessage = 'यूज़रनेम आवश्यक है (Username is required)';
      this.cdr.markForCheck();
      return;
    }

    this.isLoading = true;
    this.cdr.markForCheck();

    const loginUrl = '/api/_sutram/auth/login';

    this.http.post<{ success: boolean; result?: { user: any; rights: any[]; token?: string }; error?: string }>(loginUrl, {
      username: this.username.trim(),
      password: (this.password ?? '').trim()
    }).subscribe({
      next: (res) => {
        this.isLoading = false;
        if (res && res.success && res.result) {
          const { user, rights, token } = res.result;
          this.password = '';
          this.visible = false;
          this.visibleChange.emit(false);
          this.authenticated.emit({ user, rights: rights || [], token: token || user?.token || '' });
        } else {
          this.errorMessage = res?.error || 'लॉगिन असफल (Authentication failed)';
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoading = false;
        this.errorMessage = err?.error?.error || err?.message || 'सर्वर से कनेक्ट करने में त्रुटि (Server connection error)';
        this.cdr.markForCheck();
      }
    });
  }
}
