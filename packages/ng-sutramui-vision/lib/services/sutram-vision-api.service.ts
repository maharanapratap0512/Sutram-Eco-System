import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { VisionExtractResult, VisionProfile, VisionMode, DocumentScanType, VisionCorrectionItem } from '../models/vision.model';
import { SutramVisionProfileService } from './sutram-vision-profile.service';

@Injectable({
  providedIn: 'root'
})
export class SutramVisionApiService {
  private baseUrl = '/_sutram/vision';

  constructor(
    private http: HttpClient,
    private profileService: SutramVisionProfileService
  ) {}

  public testConnection(profile: VisionProfile): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/test-connection`, {
      provider: profile.provider,
      apiKey: profile.apiKey,
      model: profile.model,
      endpoint: profile.endpoint
    }).pipe(
      catchError(err => {
        return throwError(() => new Error(err.error?.message || err.message || 'Connection failed'));
      })
    );
  }

  public extract(params: {
    imageBase64: string;
    documentType?: DocumentScanType;
    mode?: VisionMode;
    targetColumns?: string[];
    masterVocabulary?: string[];
    overrideProfile?: VisionProfile;
    options?: any;
  }): Observable<VisionExtractResult> {
    const activeProfile = params.overrideProfile || this.profileService.getActiveProfile();
    const allProfiles = this.profileService.getProfiles();
    const settings = this.profileService.getSettings();

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-VLM-Provider': activeProfile?.provider || 'gemini',
      'X-VLM-Api-Key': activeProfile?.apiKey || '',
      'X-VLM-Model': activeProfile?.model || '',
      'X-VLM-Mode': params.mode || settings.defaultMode || 'normal'
    });

    const body = {
      imageBase64: params.imageBase64,
      documentType: params.documentType || settings.defaultDocType || 'parchi',
      mode: params.mode || settings.defaultMode || 'normal',
      targetColumns: params.targetColumns || [],
      masterVocabulary: params.masterVocabulary || [],
      options: params.options || {},
      apiProfiles: allProfiles,
      autoRotate: settings.autoRotateOnRateLimit
    };

    return this.http.post<VisionExtractResult>(`${this.baseUrl}/extract`, body, { headers }).pipe(
      catchError(err => {
        const msg = err.error?.message || err.message || 'Vision OCR extraction failed';
        console.error('❌ [SutramVisionApiService] Extract error:', err);
        return throwError(() => new Error(msg));
      })
    );
  }

  public batchExtract(params: {
    images: string[];
    documentType?: DocumentScanType;
    mode?: VisionMode;
    bulkMerged?: boolean;
    targetColumns?: string[];
    masterVocabulary?: string[];
  }): Observable<any> {
    const activeProfile = this.profileService.getActiveProfile();
    const allProfiles = this.profileService.getProfiles();
    const settings = this.profileService.getSettings();

    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'X-VLM-Provider': activeProfile?.provider || 'gemini',
      'X-VLM-Api-Key': activeProfile?.apiKey || '',
      'X-VLM-Model': activeProfile?.model || '',
      'X-VLM-Mode': params.mode || settings.defaultMode || 'normal'
    });

    const body = {
      images: params.images,
      documentType: params.documentType || settings.defaultDocType || 'parchi',
      mode: params.mode || settings.defaultMode || 'normal',
      bulkMerged: params.bulkMerged !== false,
      targetColumns: params.targetColumns || [],
      masterVocabulary: params.masterVocabulary || [],
      apiProfiles: allProfiles,
      autoRotate: settings.autoRotateOnRateLimit
    };

    return this.http.post<any>(`${this.baseUrl}/batch-extract`, body, { headers }).pipe(
      catchError(err => {
        const msg = err.error?.message || err.message || 'Bulk Vision extraction failed';
        return throwError(() => new Error(msg));
      })
    );
  }

  public saveCorrection(correction: VisionCorrectionItem): Observable<any> {
    return this.http.post<any>(`${this.baseUrl}/corrections/save`, correction).pipe(
      catchError(err => throwError(() => new Error(err.error?.message || 'Failed to save correction')))
    );
  }

  public getCorrections(table: string = 'default'): Observable<any> {
    return this.http.get<any>(`${this.baseUrl}/corrections?table=${encodeURIComponent(table)}`).pipe(
      catchError(err => throwError(() => new Error(err.error?.message || 'Failed to load corrections')))
    );
  }
}
