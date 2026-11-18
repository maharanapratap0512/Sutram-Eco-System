/**
 * sutram-excel-api.service.ts
 * ─────────────────────────────────────────────────────────────
 * Type-safe HTTP Client for sutramExcel backend API.
 * Communicates with /_sutram/excel/* and /api/_sutram/* endpoints.
 * Provides safe query-string aware URL builders (buildUrl, buildApiUrl)
 * so that endpoints with query parameters are constructed reliably.
 * ─────────────────────────────────────────────────────────────
 */

import { Injectable, Inject, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, of, catchError } from 'rxjs';
import { SutramTableConfig } from '../models/sutram-excel.model';
import { SutramCorrectionItem, DictionaryEntry } from '../models/sutram-correction.model';

export const SUTRAM_EXCEL_API_BASE = 'SUTRAM_EXCEL_API_BASE';

interface ApiResponse<T = any> {
  success: boolean;
  result?: T;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SutramExcelApiService {
  private baseUri: string;

  constructor(
    private http: HttpClient,
    @Optional() @Inject(SUTRAM_EXCEL_API_BASE) apiBase?: string
  ) {
    this.baseUri = apiBase || '/_sutram/excel';
    if (this.baseUri.endsWith('/')) {
      this.baseUri = this.baseUri.slice(0, -1);
    }
  }

  public setBaseUri(uri: string): void {
    this.baseUri = (uri || '/_sutram/excel').trim();
    if (this.baseUri.endsWith('/')) {
      this.baseUri = this.baseUri.slice(0, -1);
    }
  }

  public getBaseUri(): string {
    return this.baseUri;
  }

  /**
   * Safe URL builder for /_sutram/excel/* endpoints.
   * Properly extracts path & query string so that endpoints are appended to path,
   * not after the query string.
   */
  public buildUrl(endpoint: string, extraParams?: { [key: string]: any }): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    let path = this.baseUri;
    let baseQueryParams: string[] = [];

    if (this.baseUri.includes('?')) {
      const [basePath, baseQuery] = this.baseUri.split('?');
      path = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
      if (baseQuery) {
        baseQueryParams = baseQuery.split('&').filter(Boolean);
      }
    } else if (path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    let endpointPath = cleanEndpoint;
    let endpointQueryParams: string[] = [];
    if (cleanEndpoint.includes('?')) {
      const [ePath, eQuery] = cleanEndpoint.split('?');
      endpointPath = ePath;
      if (eQuery) {
        endpointQueryParams = eQuery.split('&').filter(Boolean);
      }
    }

    const allParams = [...baseQueryParams, ...endpointQueryParams];
    if (extraParams) {
      for (const key of Object.keys(extraParams)) {
        const val = extraParams[key];
        if (val !== undefined && val !== null && val !== '') {
          allParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
        }
      }
    }

    const finalQuery = allParams.length > 0 ? `?${allParams.join('&')}` : '';
    return `${path}${endpointPath}${finalQuery}`;
  }

  /**
   * Safe URL builder for /api/_sutram/* endpoints, preserving project query parameter if present.
   */
  public buildApiUrl(endpoint: string, extraParams?: { [key: string]: any }): string {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    let projectSlug = '';
    if (this.baseUri.includes('?')) {
      const query = this.baseUri.split('?')[1] || '';
      const params = new URLSearchParams(query);
      projectSlug = params.get('project') || '';
    }

    let endpointPath = cleanEndpoint;
    let endpointQueryParams: string[] = [];
    if (cleanEndpoint.includes('?')) {
      const [ePath, eQuery] = cleanEndpoint.split('?');
      endpointPath = ePath;
      if (eQuery) {
        endpointQueryParams = eQuery.split('&').filter(Boolean);
      }
    }

    const allParams = [...endpointQueryParams];
    if (projectSlug && !allParams.some(p => p.startsWith('project='))) {
      allParams.push(`project=${encodeURIComponent(projectSlug)}`);
    }
    if (extraParams) {
      for (const key of Object.keys(extraParams)) {
        const val = extraParams[key];
        if (val !== undefined && val !== null && val !== '') {
          allParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
        }
      }
    }

    const finalQuery = allParams.length > 0 ? `?${allParams.join('&')}` : '';
    return `${endpointPath}${finalQuery}`;
  }

  /**
   * GET /tables - Fetch list of registered tables
   */
  public getRegisteredTables(): Observable<Array<{ table: string; display_name: string }>> {
    return this.http.get<ApiResponse<Array<{ table: string; display_name: string }>>>(this.buildUrl('/tables')).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * GET /reports - Fetch list of dynamic reports and views
   */
  public getReports(): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildUrl('/reports')).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * GET /config/:table - Fetch derived schema and column config
   */
  public getTableConfig(tableName: string): Observable<SutramTableConfig> {
    return this.http.get<ApiResponse<SutramTableConfig>>(this.buildUrl(`/config/${encodeURIComponent(tableName)}`)).pipe(
      map(res => res.result!)
    );
  }

  /**
   * GET /ref-data/:table - Fetch reference lookup records for FK autocomplete and validation
   */
  public getRefData(tableName: string): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildUrl(`/ref-data/${encodeURIComponent(tableName)}`)).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * GET live records for table using direct Sutram API (/data/:table)
   */
  public getTableData(tableName: string, limit: number = 500, offset: number = 0): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildUrl(`/data/${encodeURIComponent(tableName)}?_limit=${limit}&_offset=${offset}`)).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * GET /data/:table - Chunked lazy-loading with direct DB search, sort, and filters support
   */
  public getTableDataChunk(
    tableName: string,
    opts: {
      limit?: number;
      offset?: number;
      search?: string;
      sort?: string;
      order?: 'ASC' | 'DESC';
      filters?: any;
      export?: boolean;
    } = {}
  ): Observable<{ rows: any[]; total: number; offset: number; limit: number }> {
    const params: string[] = [];
    if (opts.export) {
      params.push(`_export=1`);
      params.push(`_limit=-1`);
    } else {
      params.push(`_limit=${opts.limit ?? 100}`);
      params.push(`_offset=${opts.offset ?? 0}`);
    }
    params.push(`_full=1`);
    if (opts.search) params.push(`_search=${encodeURIComponent(opts.search)}`);
    if (opts.sort) params.push(`_sort=${encodeURIComponent(opts.sort)}&_order=${opts.order || 'ASC'}`);
    if (opts.filters && Object.keys(opts.filters).length > 0) {
      params.push(`_filters=${encodeURIComponent(JSON.stringify(opts.filters))}`);
    }
    const queryPart = params.length > 0 ? `?${params.join('&')}` : '';
    const url = this.buildUrl(`/data/${encodeURIComponent(tableName)}${queryPart}`);
    return this.http.get<any>(url).pipe(
      map(res => ({
        rows: res.result || [],
        total: res.total !== undefined ? res.total : (res.result?.length || 0),
        offset: res.offset || 0,
        limit: res.limit || (opts.limit ?? 100)
      }))
    );
  }

  /**
   * GET /filter-values/:table/:column - Fetch distinct values and counts directly from database
   */
  public getColumnFilterValues(tableName: string, colName: string): Observable<{
    values: Array<{ display: string; value: any; count?: number }>;
    blankCount: number;
  }> {
    return this.http.get<ApiResponse<{
      values: Array<{ display: string; value: any; count?: number }>;
      blankCount: number;
    }>>(this.buildUrl(`/filter-values/${encodeURIComponent(tableName)}/${encodeURIComponent(colName)}`)).pipe(
      map(res => res.result || { values: [], blankCount: 0 })
    );
  }

  /**
   * POST /verify/:table - Server-side FK matching, Unicode normalization, and dictionary check
   */
  public verifyRows(
    tableName: string,
    rows: any[]
  ): Observable<{ rows: any[]; correctionList: SutramCorrectionItem[] }> {
    return this.http.post<ApiResponse<{ rows: any[]; correctionList: SutramCorrectionItem[] }>>(
      this.buildUrl(`/verify/${encodeURIComponent(tableName)}`),
      { rows }
    ).pipe(
      map(res => res.result || { rows: [], correctionList: [] })
    );
  }

  /**
   * POST /import/:table - Single row trigger-aware insertion
   */
  public importRow(
    tableName: string,
    row: any
  ): Observable<{ status: 'inserted' | 'updated' | 'duplicate' | 'rejected'; data?: any; error?: string }> {
    return this.http.post<ApiResponse<{ status: any; data?: any }>>(
      this.buildUrl(`/import/${encodeURIComponent(tableName)}`),
      { row }
    ).pipe(
      map(res => {
        if (!res.success) {
          return { status: 'rejected', error: res.error || 'Import failed' };
        }
        return res.result || { status: 'inserted' };
      })
    );
  }

  /**
   * POST /update/:table - Single row update on duplicate match
   */
  public updateRow(
    tableName: string,
    row: any
  ): Observable<{ status: string; data?: any; error?: string }> {
    return this.http.post<ApiResponse<any>>(this.buildUrl(`/update/${encodeURIComponent(tableName)}`), { row }).pipe(
      map(res => res.result || { status: 'updated' })
    );
  }

  /**
   * POST /error-report - Generates styled ExcelJS workbook of rejected rows
   */
  public downloadErrorReport(tableName: string, rejectedRows: any[]): Observable<Blob> {
    return this.http.post(this.buildUrl('/error-report'), { table: tableName, rows: rejectedRows }, {
      responseType: 'blob'
    });
  }

  /**
   * GET /dictionary - List all dictionary entries
   */
  public getDictionary(type?: string): Observable<DictionaryEntry[]> {
    const endpoint = type ? `/dictionary/${encodeURIComponent(type)}` : '/dictionary';
    return this.http.get<ApiResponse<DictionaryEntry[]>>(this.buildUrl(endpoint)).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * POST /dictionary - Add a new correction entry to xls_dictionary
   */
  public addDictionaryEntry(entry: {
    type: string;
    name: string;
    ref_id: any;
    ref_id2?: any;
    extra_note?: string;
  }): Observable<{ _id: number }> {
    return this.http.post<ApiResponse<{ _id: number }>>(this.buildUrl('/dictionary'), entry).pipe(
      map(res => res.result || { _id: 0 })
    );
  }

  /**
   * PUT /dictionary/:id - Update an existing dictionary entry
   */
  public updateDictionaryEntry(id: number, patch: Partial<DictionaryEntry>): Observable<{ updated: boolean }> {
    return this.http.put<ApiResponse<{ updated: boolean }>>(this.buildUrl(`/dictionary/${encodeURIComponent(id)}`), patch).pipe(
      map(res => res.result || { updated: true })
    );
  }

  /**
   * DELETE /dictionary/:id - Soft-delete dictionary entry (active = 0)
   */
  public deleteDictionaryEntry(id: number): Observable<{ deleted: boolean }> {
    return this.http.delete<ApiResponse<{ deleted: boolean }>>(this.buildUrl(`/dictionary/${encodeURIComponent(id)}`)).pipe(
      map(res => res.result || { deleted: true })
    );
  }

  /**
   * POST /delete/:table - Delete rows by id(s) via sutramEngine
   */
  public deleteRows(
    tableName: string,
    ids: any[]
  ): Observable<{ status: string; count: number; ids: any[] }> {
    return this.http.post<ApiResponse<{ status: string; count: number; ids: any[] }>>(
      this.buildUrl(`/delete/${encodeURIComponent(tableName)}`),
      { ids }
    ).pipe(
      map((res: ApiResponse<{ status: string; count: number; ids: any[] }>) => {
        if (!res.success) {
          throw new Error(res.error || 'Delete failed');
        }
        return res.result || { status: 'deleted', count: ids.length, ids };
      })
    );
  }

  /**
   * GET table UI configuration (columns, labels, formats, sort order, selected_keys)
   * Reads from /api/_sutram/schema/table-config/:table directly
   */
  public getTableUiConfig(tableName: string): Observable<any> {
    return this.http.get<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/table-config/${encodeURIComponent(tableName)}`)).pipe(
      map(res => res.result || null),
      catchError(() => of(null))
    );
  }

  /**
   * POST table UI configuration
   * Saves to /api/_sutram/schema/table-config/:table directly
   */
  public saveTableUiConfig(tableName: string, data: any): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/table-config/${encodeURIComponent(tableName)}`), data).pipe(
      catchError(() => of({ success: false }))
    );
  }

  /**
   * GET /api/_sutram/schema/triggers/:table
   */
  public getTableTriggers(tableName: string): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildApiUrl(`/api/_sutram/schema/triggers/${encodeURIComponent(tableName)}`)).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * POST /api/_sutram/schema/triggers
   */
  public createTrigger(def: any): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/schema/triggers'), def);
  }

  /**
   * DELETE /api/_sutram/schema/triggers/:id
   */
  public deleteTrigger(id: number | string): Observable<any> {
    return this.http.delete<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/triggers/${encodeURIComponent(id)}`));
  }

  /**
   * GET UI sutras / formulas for a table
   * Reads from /api/_sutram/schema/ui-sutras/:table directly
   */
  public getUiSutras(tableName: string): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildApiUrl(`/api/_sutram/schema/ui-sutras/${encodeURIComponent(tableName)}`)).pipe(
      map(res => res.result || []),
      catchError(() => of([]))
    );
  }

  /**
   * POST UI sutras / formulas for a table
   * Saves to /api/_sutram/schema/ui-sutras/:table directly
   */
  public saveUiSutras(tableName: string, formulas: any[]): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/ui-sutras/${encodeURIComponent(tableName)}`), { formulas }).pipe(
      catchError(() => of({ success: false }))
    );
  }

  /**
   * GET /api/_sutram/schema/users
   */
  public getUsers(): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildApiUrl('/api/_sutram/schema/users')).pipe(
      map(res => res.result || [])
    );
  }

  /**
   * POST /api/_sutram/schema/users
   */
  public createUser(user: any): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/schema/users'), user);
  }

  /**
   * PUT /api/_sutram/schema/users/:id
   */
  public updateUser(id: number | string, user: any): Observable<any> {
    return this.http.put<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/users/${encodeURIComponent(id)}`), user);
  }

  /**
   * DELETE /api/_sutram/schema/users/:id
   */
  public deleteUser(id: number | string): Observable<any> {
    return this.http.delete<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/users/${encodeURIComponent(id)}`));
  }

  /**
   * GET /api/_sutram/schema/user-rights/:userId
   */
  public getUserRights(userId: number | string): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildApiUrl(`/api/_sutram/schema/user-rights/${encodeURIComponent(userId)}`)).pipe(
      map(res => res.result || []),
      catchError(() => of([]))
    );
  }

  /**
   * POST /api/_sutram/schema/user-rights/:userId
   */
  public saveUserRights(userId: number | string, rights: any[]): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/schema/user-rights/${encodeURIComponent(userId)}`), { rights }).pipe(
      catchError(() => of({ success: false }))
    );
  }

  /**
   * POST /api/_sutram/auth/verify-unmask
   */
  public verifyUnmask(payload: { userId?: number | string; table?: string; column?: string; secret: string }): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/auth/verify-unmask'), payload);
  }

  /**
   * POST /api/_sutram/auth/set-column-security
   */
  public setColumnSecurity(payload: { table: string; column: string; secret: string }): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/auth/set-column-security'), payload);
  }

  // ── Reminders & Smart Watchdog APIs ──────────────────────────

  /**
   * GET /api/_sutram/reminders/rules
   */
  public getReminderRules(query?: any): Observable<any[]> {
    return this.http.get<ApiResponse<any[]>>(this.buildApiUrl('/api/_sutram/reminders/rules'), { params: query || {} }).pipe(
      map(res => res.result || []),
      catchError(() => of([]))
    );
  }

  /**
   * POST /api/_sutram/reminders/rules
   */
  public createReminderRule(rule: any): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/reminders/rules'), rule);
  }

  /**
   * PUT /api/_sutram/reminders/rules/:id
   */
  public updateReminderRule(id: number | string, rule: any): Observable<any> {
    return this.http.put<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/reminders/rules/${encodeURIComponent(id)}`), rule);
  }

  /**
   * DELETE /api/_sutram/reminders/rules/:id
   */
  public deleteReminderRule(id: number | string): Observable<any> {
    return this.http.delete<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/reminders/rules/${encodeURIComponent(id)}`));
  }

  /**
   * POST /api/_sutram/reminders/test
   * Dry-run preview matching sample rows against active database
   */
  public testReminderRule(rule: any): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/reminders/test'), rule);
  }

  /**
   * GET /api/_sutram/reminders/active
   * Returns all active/triggered alerts
   */
  public getActiveReminders(): Observable<any[]> {
    return this.http.get<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/reminders/active')).pipe(
      map(res => {
        if (!res || !res.result) return [];
        if (Array.isArray(res.result)) return res.result;
        const active = res.result.activeAlerts || [];
        const perm = res.result.permanentAlerts || [];
        const combined = [...active];
        for (const p of perm) {
          if (!combined.some(c => (c.log_id && c.log_id === p.log_id) || c.rule_id === p.rule_id)) {
            combined.push(p);
          }
        }
        return combined;
      }),
      catchError(() => of([]))
    );
  }

  /**
   * POST /api/_sutram/reminders/evaluate
   * Force evaluates all reminder rules against live database
   */
  public evaluateReminders(force: boolean = false): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl('/api/_sutram/reminders/evaluate'), { force });
  }

  /**
   * POST /api/_sutram/reminders/snooze/:logId
   * Snoozes an active reminder for N minutes (default 15)
   */
  public snoozeReminder(logId: number | string, minutes: number = 15): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/reminders/snooze/${encodeURIComponent(logId)}`), { minutes });
  }

  /**
   * POST /api/_sutram/reminders/dismiss/:logId
   * Dismisses a reminder alert
   */
  public dismissReminder(logId: number | string, user?: string, reason?: string): Observable<any> {
    return this.http.post<ApiResponse<any>>(this.buildApiUrl(`/api/_sutram/reminders/dismiss/${encodeURIComponent(logId)}`), { user, reason });
  }
}
