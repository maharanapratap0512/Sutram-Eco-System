import { Component, Input, Output, EventEmitter, OnInit, ChangeDetectionStrategy, ChangeDetectorRef } from '@angular/core';
import { VisionProfile, VlmProviderType } from '../../models/vision.model';
import { SutramVisionProfileService } from '../../services/sutram-vision-profile.service';
import { SutramVisionApiService } from '../../services/sutram-vision-api.service';

@Component({
  selector: 'sutram-vision-profiles-modal',
  templateUrl: './vision-profiles-modal.component.html',
  styleUrls: ['./vision-profiles-modal.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class VisionProfilesModalComponent implements OnInit {
  @Input() visible: boolean = false;
  @Input() isDarkMode: boolean = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() profilesUpdated = new EventEmitter<VisionProfile[]>();

  profiles: VisionProfile[] = [];
  autoRotateOnRateLimit: boolean = true;
  testingProfileId: string | null = null;

  // New Profile Form
  isAddingNew: boolean = false;
  newProfile: Partial<VisionProfile> = {
    label: '',
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-3.8-flash',
    endpoint: ''
  };

  providerOptions: { label: string; value: VlmProviderType; defaultModel: string; hint: string }[] = [
    { label: 'Google AI Studio (Gemini 3.8 Flash) — 100% Free Tier', value: 'gemini', defaultModel: 'gemini-3.8-flash', hint: '15 RPM & 1,500 scans/day free!' },
    { label: 'Groq Cloud (Llama 3.2 Vision) — Free Credits', value: 'groq', defaultModel: 'llama-3.2-11b-vision-preview', hint: 'Lightning fast vision inference' },
    { label: 'OpenAI (GPT-4o mini)', value: 'openai', defaultModel: 'gpt-4o-mini', hint: 'Reliable paid model ($0.15/1M)' },
    { label: 'Local Ollama (Offline / Private)', value: 'ollama', defaultModel: 'qwen2-vl:latest', hint: '0 Cost, runs on local PC' }
  ];

  constructor(
    private profileService: SutramVisionProfileService,
    private apiService: SutramVisionApiService,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.loadProfiles();
  }

  loadProfiles(): void {
    this.profiles = this.profileService.getProfiles();
    this.autoRotateOnRateLimit = this.profileService.getSettings().autoRotateOnRateLimit;
    this.cdr.markForCheck();
  }

  onProviderChange(provider: VlmProviderType): void {
    const opt = this.providerOptions.find(o => o.value === provider);
    if (opt) {
      this.newProfile.model = opt.defaultModel;
      if (provider === 'ollama') {
        this.newProfile.endpoint = 'http://localhost:11434';
      }
    }
    this.cdr.markForCheck();
  }

  testProfile(profile: VisionProfile): void {
    this.testingProfileId = profile.id;
    this.cdr.markForCheck();

    this.apiService.testConnection(profile).subscribe({
      next: res => {
        this.testingProfileId = null;
        if (res.success) {
          this.profileService.updateProfile(profile.id, {
            status: 'online',
            statusMessage: 'Connected successfully',
            lastTested: Date.now()
          });
        } else {
          this.profileService.updateProfile(profile.id, {
            status: 'error',
            statusMessage: res.message || 'Connection failed',
            lastTested: Date.now()
          });
        }
        this.loadProfiles();
      },
      error: err => {
        this.testingProfileId = null;
        this.profileService.updateProfile(profile.id, {
          status: 'error',
          statusMessage: err.message,
          lastTested: Date.now()
        });
        this.loadProfiles();
      }
    });
  }

  saveNewProfile(): void {
    if (!this.newProfile.label) {
      this.newProfile.label = `${this.newProfile.provider?.toUpperCase()} Account ${this.profiles.length + 1}`;
    }
    this.profileService.addProfile({
      label: this.newProfile.label!,
      provider: this.newProfile.provider as VlmProviderType,
      apiKey: this.newProfile.apiKey || '',
      model: this.newProfile.model || '',
      endpoint: this.newProfile.endpoint || '',
      status: 'untested'
    });

    this.isAddingNew = false;
    this.newProfile = { label: '', provider: 'gemini', apiKey: '', model: 'gemini-2.0-flash', endpoint: '' };
    this.loadProfiles();
    this.profilesUpdated.emit(this.profiles);
  }

  setDefault(id: string): void {
    this.profileService.setDefaultProfile(id);
    this.loadProfiles();
    this.profilesUpdated.emit(this.profiles);
  }

  deleteProfile(id: string): void {
    this.profileService.deleteProfile(id);
    this.loadProfiles();
    this.profilesUpdated.emit(this.profiles);
  }

  toggleAutoRotate(): void {
    this.profileService.updateSettings({ autoRotateOnRateLimit: this.autoRotateOnRateLimit });
  }

  close(): void {
    this.visible = false;
    this.visibleChange.emit(false);
  }
}
