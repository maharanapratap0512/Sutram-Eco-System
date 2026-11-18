import { Injectable, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable } from 'rxjs';
import { VisionProfile, VisionMode, DocumentScanType } from '../models/vision.model';

const STORAGE_KEY_PROFILES = 'sutram_vision_profiles_v1';
const STORAGE_KEY_SETTINGS = 'sutram_vision_settings_v1';

export interface VisionGlobalSettings {
  autoRotateOnRateLimit: boolean;
  defaultMode: VisionMode;
  defaultDocType: DocumentScanType;
  maxImageDimension: number;
}

@Injectable({
  providedIn: 'root'
})
export class SutramVisionProfileService {
  private profilesSubject = new BehaviorSubject<VisionProfile[]>([]);
  public profiles$: Observable<VisionProfile[]> = this.profilesSubject.asObservable();

  private settingsSubject = new BehaviorSubject<VisionGlobalSettings>({
    autoRotateOnRateLimit: true,
    defaultMode: 'normal',
    defaultDocType: 'tabular_register',
    maxImageDimension: 1536
  });
  public settings$: Observable<VisionGlobalSettings> = this.settingsSubject.asObservable();

  constructor(@Optional() private http: HttpClient | null) {
    this.loadFromStorage();
    this.loadFromDatabase();
  }

  public loadFromDatabase(): void {
    if (!this.http) return;
    this.http.get<any>('/_sutram/vision/profiles').subscribe({
      next: res => {
        if (res && res.success && Array.isArray(res.profiles) && res.profiles.length > 0) {
          // If profiles found in database sys_meta, sync to state & localStorage
          this.profilesSubject.next(res.profiles);
          try {
            localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(res.profiles));
          } catch (e) {}
        }
      },
      error: () => {
        // Fallback to localStorage already initialized
      }
    });
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
      let profiles: VisionProfile[] = raw ? JSON.parse(raw) : [];

      // Auto-migrate any deprecated gemini-2.0-flash to gemini-3.8-flash
      let migrated = false;
      profiles = profiles.map(p => {
        if (p.model === 'gemini-2.0-flash') {
          p.model = 'gemini-3.8-flash';
          if (p.label && p.label.includes('2.0')) {
            p.label = p.label.replace('2.0', '3.8');
          }
          migrated = true;
        }
        return p;
      });

      // If empty, seed an initial recommended template for Google Gemini Free Tier
      if (profiles.length === 0) {
        profiles = [
          {
            id: 'prof_gemini_free_1',
            label: 'Google AI Studio (Gemini 3.8 Flash - 100% Free)',
            provider: 'gemini',
            apiKey: '',
            model: 'gemini-3.8-flash',
            isDefault: true,
            status: 'untested'
          }
        ];
        this.saveProfiles(profiles);
      } else {
        if (migrated) {
          this.saveProfiles(profiles);
        } else {
          this.profilesSubject.next(profiles);
        }
      }

      const rawSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (rawSettings) {
        this.settingsSubject.next({ ...this.settingsSubject.value, ...JSON.parse(rawSettings) });
      }
    } catch (e) {
      console.warn('Failed to load Vision profiles from localStorage:', e);
    }
  }

  public getProfiles(): VisionProfile[] {
    return this.profilesSubject.value;
  }

  public getActiveProfile(): VisionProfile | null {
    const list = this.getProfiles();
    return list.find(p => p.isDefault) || list[0] || null;
  }

  public saveProfiles(profiles: VisionProfile[]): void {
    try {
      localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(profiles));
      this.profilesSubject.next(profiles);

      // Persist to database sys_meta
      if (this.http) {
        this.http.post<any>('/_sutram/vision/profiles', { profiles }).subscribe({
          next: () => {},
          error: (err) => console.warn('Could not sync vision profiles to DB:', err)
        });
      }
    } catch (e) {
      console.error('Failed to save Vision profiles:', e);
    }
  }

  public addProfile(profile: Omit<VisionProfile, 'id'>): VisionProfile {
    const newProf: VisionProfile = {
      ...profile,
      id: 'prof_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)
    };
    const current = this.getProfiles();
    if (newProf.isDefault || current.length === 0) {
      current.forEach(p => (p.isDefault = false));
      newProf.isDefault = true;
    }
    const updated = [...current, newProf];
    this.saveProfiles(updated);
    return newProf;
  }

  public updateProfile(id: string, patch: Partial<VisionProfile>): void {
    const current = this.getProfiles().map(p => {
      if (p.id === id) {
        const merged = { ...p, ...patch };
        return merged;
      }
      if (patch.isDefault && p.id !== id) {
        return { ...p, isDefault: false };
      }
      return p;
    });
    this.saveProfiles(current);
  }

  public deleteProfile(id: string): void {
    let current = this.getProfiles().filter(p => p.id !== id);
    if (current.length > 0 && !current.some(p => p.isDefault)) {
      current[0].isDefault = true;
    }
    this.saveProfiles(current);
  }

  public setDefaultProfile(id: string): void {
    const current = this.getProfiles().map(p => ({
      ...p,
      isDefault: p.id === id
    }));
    this.saveProfiles(current);
  }

  public updateSettings(patch: Partial<VisionGlobalSettings>): void {
    const updated = { ...this.settingsSubject.value, ...patch };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(updated));
    this.settingsSubject.next(updated);
  }

  public getSettings(): VisionGlobalSettings {
    return this.settingsSubject.value;
  }
}
