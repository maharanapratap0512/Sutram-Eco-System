import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface BackupItem {
  id: string;
  name: string;
  timestamp: string;
  date: string;
  path: string;
  sizeBytes: number;
  sizeFormatted: string;
  itemsCount: number;
}

export interface UpdateResponse {
  success: boolean;
  backupId?: string;
  backupPath?: string;
  updatedFolders?: string[];
  message?: string;
  error?: string;
}

export interface RollbackResponse {
  success: boolean;
  backupId?: string;
  restoredFolders?: string[];
  message?: string;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AppUpdateService {
  constructor(private http: HttpClient) {}

  public getBackups(): Observable<{ success: boolean; count: number; result: BackupItem[]; error?: string }> {
    return this.http.get<{ success: boolean; count: number; result: BackupItem[]; error?: string }>('/api/_sutram/update/backups');
  }

  public applyUpdate(file: File): Observable<UpdateResponse> {
    const formData = new FormData();
    formData.append('updateZip', file, file.name);
    return this.http.post<UpdateResponse>('/api/_sutram/update/upload', formData);
  }

  public rollbackBackup(backupId: string): Observable<RollbackResponse> {
    return this.http.post<RollbackResponse>('/api/_sutram/update/rollback', { backupId });
  }
}
