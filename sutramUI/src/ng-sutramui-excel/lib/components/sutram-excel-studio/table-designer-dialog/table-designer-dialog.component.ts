import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, ChangeDetectorRef, Optional } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SchemaHeuristicsUtil } from '../../../utils/schema-heuristics';
import { SutramExcelApiService } from '../../../services/sutram-excel-api.service';

export interface CatalogColumn {
  column_name: string;
  label?: string;
  type?: string;
  is_pk?: boolean;
  ref?: string | null;
}

export interface TableCatalogItem {
  table_name: string;
  display_name: string;
  columns: CatalogColumn[];
  candidate_display_columns?: string[];
}

export interface DesignerColumnRow {
  name: string;
  original_name?: string;
  label: string;
  sql_type: string;
  col_type: string;
  length_precision: string;
  is_pk: boolean;
  is_required: boolean;
  is_unique: boolean;
  has_index: boolean;
  default_type: 'NONE' | 'NULL' | 'CURRENT_TIMESTAMP' | 'CUSTOM';
  default_value: string;
  ref_table: string;
  ref_col: string;
  ref_select: string[];
  on_delete: string;
  candidate_ref_cols?: Array<{ label: string; value: string }>;
  candidate_display_cols?: Array<{ label: string; value: string }>;
  user_touched_type?: boolean;
}

@Component({
  selector: 'sutram-table-designer-dialog',
  templateUrl: './table-designer-dialog.component.html',
  styleUrls: ['./table-designer-dialog.component.scss']
})
export class TableDesignerDialogComponent implements OnInit, OnChanges {
  private _visible: boolean = false;

  @Input()
  public get visible(): boolean {
    return this._visible;
  }
  public set visible(val: boolean) {
    this._visible = val;
  }

  @Input() public isDarkMode: boolean = false;
  @Input() public apiBase: string = '/_sutram/excel';
  @Input() public editTableName: string | null = null;

  @Output() public visibleChange = new EventEmitter<boolean>();
  @Output() public tableCreated = new EventEmitter<string>();
  @Output() public tableUpdated = new EventEmitter<string>();

  public newTableName: string = '';
  public newTableLabel: string = '';
  public newTableDesc: string = '';
  public showSqlPreview: boolean = false;
  public liveSqlPreview: string = '';
  public isCreatingTable: boolean = false;
  public isLoadingEdit: boolean = false;
  public existingRowCount: number = 0;
  public originalColumnNames: string[] = [];
  public catalog: TableCatalogItem[] = [];

  public get isEditMode(): boolean {
    return !!this.editTableName;
  }

  public sqlTypes: Array<{ label: string; value: string; hint: string }> = [
    { label: 'VARCHAR', value: 'VARCHAR', hint: 'Short string up to 255 chars' },
    { label: 'INTEGER', value: 'INT', hint: 'Whole numbers' },
    { label: 'BIGINT', value: 'BIGINT', hint: 'Large numeric IDs or timestamps' },
    { label: 'DECIMAL', value: 'DECIMAL', hint: 'Accurate decimals (rate, amount)' },
    { label: 'DATE', value: 'DATE', hint: 'YYYY-MM-DD' },
    { label: 'DATETIME', value: 'DATETIME', hint: 'YYYY-MM-DD HH:MM:SS' },
    { label: 'TIME', value: 'TIME', hint: 'HH:MM:SS' },
    { label: 'BOOLEAN', value: 'BOOLEAN', hint: '1 or 0 flag' },
    { label: 'TEXT', value: 'TEXT', hint: 'Unlimited remarks or paragraphs' },
    { label: 'JSON', value: 'JSON', hint: 'Structured JSON objects/arrays' },
    { label: 'PASSWORD 🔒', value: 'PASSWORD', hint: 'Masked string (••••••••)' },
    { label: 'ENUM', value: 'ENUM', hint: 'Allowed value set' },
    { label: 'FK 🔗', value: 'FK', hint: 'References primary key of another table' }
  ];

  public defaultTypes: Array<{ label: string; value: string }> = [
    { label: 'None', value: 'NONE' },
    { label: 'NULL', value: 'NULL' },
    { label: 'CURRENT_TIMESTAMP', value: 'CURRENT_TIMESTAMP' },
    { label: 'Custom', value: 'CUSTOM' }
  ];

  public onDeleteOptions: Array<{ label: string; value: string }> = [
    { label: 'NO ACTION', value: 'NO ACTION' },
    { label: 'CASCADE (Delete child rows)', value: 'CASCADE' },
    { label: 'SET NULL (Set to NULL)', value: 'SET NULL' },
    { label: 'RESTRICT (Block delete)', value: 'RESTRICT' }
  ];

  public designerColumns: DesignerColumnRow[] = [];

  constructor(
    private http: HttpClient,
    private cdr: ChangeDetectorRef,
    @Optional() private api?: SutramExcelApiService
  ) {}

  ngOnInit(): void {
    if (this._visible && this.designerColumns.length === 0 && !this.isLoadingEdit) {
      this.initDesigner();
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Runs AFTER all @Input() bindings (both visible AND editTableName) are applied together
    const becameVisible = !!(changes['visible'] && changes['visible'].currentValue === true && !changes['visible'].previousValue);
    const targetChangedWhileOpen = !!(this._visible && changes['editTableName'] && changes['editTableName'].currentValue !== changes['editTableName'].previousValue);
    if (becameVisible || targetChangedWhileOpen) {
      this.initDesigner();
    }
  }

  public initDesigner(): void {
    this.newTableName = '';
    this.newTableLabel = '';
    this.newTableDesc = '';
    this.showSqlPreview = false;
    this.existingRowCount = 0;
    this.originalColumnNames = [];
    this.loadCatalog();

    if (this.editTableName) {
      this.loadTableForEdit(this.editTableName);
      return;
    }

    const pkRow: DesignerColumnRow = {
      name: '_id',
      original_name: '_id',
      label: 'ID (Primary Key)',
      sql_type: 'INTEGER',
      col_type: 'number',
      length_precision: '',
      is_pk: true,
      is_required: true,
      is_unique: true,
      has_index: true,
      default_type: 'NONE',
      default_value: '',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'NO ACTION',
      user_touched_type: true
    };

    const firstCustomCol: DesignerColumnRow = {
      name: '',
      label: '',
      sql_type: 'VARCHAR',
      col_type: 'string',
      length_precision: '255',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: false,
      default_type: 'NONE',
      default_value: '',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'RESTRICT',
      user_touched_type: false
    };

    this.designerColumns = [pkRow, firstCustomCol];
    this.updateLiveSql();
    this.cdr.markForCheck();
  }

  private mapBackendColumnToDesignerRow(c: any): DesignerColumnRow {
    const rawSql = String(c.sql_type || '').toUpperCase();
    const colType = String(c.col_type || 'string').toLowerCase();
    let sqlType = 'VARCHAR';
    let lenPrec = '';

    if (c.is_pk || c.column_name === '_id') {
      sqlType = 'INTEGER';
    } else if (c.ref_table) {
      sqlType = 'FK';
    } else if (colType === 'date' || rawSql === 'DATE') {
      sqlType = 'DATE';
    } else if (colType === 'datetime' || rawSql === 'DATETIME') {
      sqlType = 'DATETIME';
    } else if (colType === 'password' || rawSql === 'PASSWORD') {
      sqlType = 'PASSWORD';
    } else if (colType === 'boolean' || rawSql.includes('BOOL') || rawSql === 'TINYINT') {
      sqlType = 'BOOLEAN';
    } else if (colType === 'json' || rawSql === 'JSON') {
      sqlType = 'JSON';
    } else if (rawSql.startsWith('DECIMAL') || rawSql.startsWith('NUMERIC') || rawSql.startsWith('FLOAT')) {
      sqlType = 'DECIMAL';
      const m = rawSql.match(/\(([^)]+)\)/);
      lenPrec = m ? m[1] : '12,2';
    } else if (rawSql.startsWith('BIGINT')) {
      sqlType = 'BIGINT';
    } else if (colType === 'number' || rawSql.startsWith('INT')) {
      sqlType = rawSql.startsWith('INT') ? 'INT' : 'DECIMAL';
    } else if (rawSql === 'TEXT') {
      sqlType = 'TEXT';
    } else {
      sqlType = 'VARCHAR';
      const m = rawSql.match(/\(([^)]+)\)/);
      lenPrec = m ? m[1] : '255';
    }

    let defaultType: 'NONE' | 'NULL' | 'CURRENT_TIMESTAMP' | 'CUSTOM' = 'NONE';
    let defaultVal = '';
    if (c.default_value !== null && c.default_value !== undefined && String(c.default_value).trim() !== '') {
      const dvStr = String(c.default_value).trim();
      if (dvStr.toUpperCase().includes('CURRENT_TIMESTAMP') || dvStr.toLowerCase().includes("datetime('now'")) {
        defaultType = 'CURRENT_TIMESTAMP';
      } else if (dvStr.toUpperCase() === 'NULL') {
        defaultType = 'NULL';
      } else {
        defaultType = 'CUSTOM';
        defaultVal = dvStr.replace(/^'|'$/g, '');
      }
    }

    const isPkCol = !!(c.is_pk || c.column_name === '_id');
    return {
      name: isPkCol ? '_id' : c.column_name,
      original_name: c.column_name,
      label: isPkCol ? 'ID (Primary Key)' : (c.label || c.column_name),
      sql_type: sqlType,
      col_type: colType,
      length_precision: lenPrec,
      is_pk: isPkCol,
      is_required: !!c.is_required,
      is_unique: !!c.is_unique,
      has_index: !!c.has_index,
      default_type: defaultType,
      default_value: defaultVal,
      ref_table: c.ref_table || '',
      ref_col: c.ref_col || '_id',
      ref_select: Array.isArray(c.ref_select) ? c.ref_select : [],
      on_delete: 'RESTRICT',
      user_touched_type: true
    };
  }

  public loadTableForEdit(tableName: string): void {
    this.isLoadingEdit = true;
    const url = this.api
      ? this.api.buildApiUrl(`/api/_sutram/schema/table-detail/${encodeURIComponent(tableName)}`)
      : `/api/_sutram/schema/table-detail/${encodeURIComponent(tableName)}`;

    this.http.get<{ success: boolean; result?: any; error?: string }>(url).subscribe({
      next: (res) => {
        this.isLoadingEdit = false;
        if (res && res.success && res.result) {
          const d = res.result;
          this.newTableName = d.table_name;
          this.newTableLabel = d.display_name || d.label || d.table_name;
          this.newTableDesc = d.description || '';
          this.existingRowCount = d.rowCount || 0;

          const cols = (d.columns || []).filter((c: any) => c.column_name !== 'hl' && c.column_name !== 'created_at' && c.column_name !== 'updated_at');
          this.originalColumnNames = cols.filter((c: any) => !c.is_pk && c.column_name !== '_id').map((c: any) => c.column_name);
          this.designerColumns = cols.map((c: any) => this.mapBackendColumnToDesignerRow(c));

          // Hydrate FK candidate dropdowns once catalog is ready
          setTimeout(() => {
            for (const col of this.designerColumns) {
              if (col.sql_type === 'FK' && col.ref_table) {
                const savedSelect = [...(col.ref_select || [])];
                this.onForeignKeyTableChange(col);
                if (savedSelect.length > 0) col.ref_select = savedSelect;
              }
            }
            this.updateLiveSql();
            this.cdr.markForCheck();
          }, 150);

          this.updateLiveSql();
        } else {
          alert('Error loading table schema: ' + (res?.error || 'Unknown error'));
          this.close();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        this.isLoadingEdit = false;
        alert('Error loading table schema: ' + (err?.error?.error || err?.message || 'Server error'));
        this.close();
        this.cdr.markForCheck();
      }
    });
  }

  public close(): void {
    this._visible = false;
    this.isLoadingEdit = false;
    this.designerColumns = [];
    this.visibleChange.emit(false);
    this.cdr.markForCheck();
  }

  public loadCatalog(): void {
    const url = this.api ? this.api.buildApiUrl('/api/_sutram/schema/catalog') : '/api/_sutram/schema/catalog';
    this.http.get<{ success: boolean; result: TableCatalogItem[] }>(url).subscribe({
      next: (res) => {
        if (res && res.success && Array.isArray(res.result) && res.result.length > 0) {
          this.catalog = res.result;
        } else {
          this.fallbackLoadCatalog();
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.fallbackLoadCatalog();
      }
    });
  }

  private fallbackLoadCatalog(): void {
    const url = this.api ? this.api.buildApiUrl('/api/_sutram/schema/tables') : '/api/_sutram/schema/tables';
    this.http.get<{ success: boolean; result: any[] }>(url).subscribe({
      next: (res) => {
        if (res && res.success && Array.isArray(res.result)) {
          this.catalog = res.result.map(t => {
            const cols = Object.keys(t.columns || {}).map(cName => ({
              column_name: cName,
              label: t.columns[cName]?.label || cName,
              type: t.columns[cName]?.type || 'string',
              is_pk: cName === '_id'
            }));
            return {
              table_name: t.table_name,
              display_name: t.display_name || t.table_name,
              columns: cols,
              candidate_display_columns: cols.filter(c => !c.is_pk).map(c => c.column_name)
            };
          });
        }
        this.cdr.markForCheck();
      }
    });
  }

  public addColumnRow(): void {
    this.designerColumns.push({
      name: '',
      label: '',
      sql_type: 'VARCHAR',
      col_type: 'string',
      length_precision: '255',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: false,
      default_type: 'NONE',
      default_value: '',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'RESTRICT',
      user_touched_type: false
    });
    this.updateLiveSql();
  }

  public removeColumnRow(idx: number): void {
    if (idx === 0) return;
    this.designerColumns.splice(idx, 1);
    this.updateLiveSql();
  }

  public moveColumnUp(idx: number): void {
    if (idx <= 1) return;
    const temp = this.designerColumns[idx];
    this.designerColumns[idx] = this.designerColumns[idx - 1];
    this.designerColumns[idx - 1] = temp;
    this.updateLiveSql();
  }

  public moveColumnDown(idx: number): void {
    if (idx < 1 || idx >= this.designerColumns.length - 1) return;
    const temp = this.designerColumns[idx];
    this.designerColumns[idx] = this.designerColumns[idx + 1];
    this.designerColumns[idx + 1] = temp;
    this.updateLiveSql();
  }

  public onColumnNameInput(col: DesignerColumnRow, idx: number): void {
    if (col.is_pk) return;
    if (!col.user_touched_type) {
      const inferred = SchemaHeuristicsUtil.inferTypeFromName(col.name);
      col.col_type = inferred.col_type;
      col.sql_type = inferred.sql_type;
      col.length_precision = inferred.length_precision;
      if (inferred.default_type) col.default_type = inferred.default_type;
      if (inferred.default_value) col.default_value = inferred.default_value;
      if (inferred.is_required !== undefined) col.is_required = inferred.is_required;

      if (inferred.is_foreign_key && inferred.candidate_table) {
        const matchTable = this.catalog.find(t => t.table_name === inferred.candidate_table);
        if (matchTable) {
          col.sql_type = 'FK';
          col.ref_table = matchTable.table_name;
          col.ref_col = '_id';
          this.onForeignKeyTableChange(col);
        }
      }
    }

    if (!col.label && col.name) {
      col.label = col.name
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    this.updateLiveSql();
  }

  public onSqlTypeChange(col: DesignerColumnRow): void {
    col.user_touched_type = true;
    if (col.sql_type === 'VARCHAR' && !col.length_precision) col.length_precision = '255';
    if (col.sql_type === 'DECIMAL' && !col.length_precision) col.length_precision = '12,2';
    if (['INT', 'BIGINT', 'DECIMAL'].includes(col.sql_type)) col.col_type = 'number';
    if (['VARCHAR', 'TEXT', 'ENUM', 'TIME'].includes(col.sql_type)) col.col_type = 'string';
    if (col.sql_type === 'BOOLEAN') col.col_type = 'boolean';
    if (col.sql_type === 'DATE') col.col_type = 'date';
    if (col.sql_type === 'DATETIME') col.col_type = 'datetime';
    if (col.sql_type === 'PASSWORD') col.col_type = 'password';
    if (col.sql_type === 'JSON') col.col_type = 'json';

    if (col.sql_type === 'FK') {
      col.col_type = 'number';
      col.ref_col = '_id';
      if (!col.ref_table && this.catalog.length > 0) {
        col.ref_table = this.catalog[0].table_name;
        this.onForeignKeyTableChange(col);
      }
    }
    this.updateLiveSql();
  }

  public onForeignKeyTableChange(col: DesignerColumnRow): void {
    if (!col.ref_table) return;
    const target = this.catalog.find(t => t.table_name === col.ref_table);
    if (!target) return;

    col.candidate_ref_cols = target.columns.map(c => ({
      label: c.label ? `${c.label} (${c.column_name})` : c.column_name,
      value: c.column_name
    }));

    const candDisplays = (target.candidate_display_columns && target.candidate_display_columns.length > 0)
      ? target.candidate_display_columns
      : target.columns.filter(c => !c.is_pk).map(c => c.column_name);

    col.candidate_display_cols = candDisplays.map(cName => {
      const found = target.columns.find(c => c.column_name === cName);
      return {
        label: found?.label ? `${found.label} (${cName})` : cName,
        value: cName
      };
    });

    if (!col.ref_select || col.ref_select.length === 0) {
      col.ref_select = candDisplays.slice(0, 2);
    }
    this.updateLiveSql();
  }

  public addAuditTimestampsPreset(): void {
    this.designerColumns.push({
      name: 'created_at',
      label: 'Created At',
      sql_type: 'DATETIME',
      col_type: 'string',
      length_precision: '',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: false,
      default_type: 'CURRENT_TIMESTAMP',
      default_value: '',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'NO ACTION',
      user_touched_type: true
    });
    this.designerColumns.push({
      name: 'updated_at',
      label: 'Updated At',
      sql_type: 'DATETIME',
      col_type: 'string',
      length_precision: '',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: false,
      default_type: 'CURRENT_TIMESTAMP',
      default_value: '',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'NO ACTION',
      user_touched_type: true
    });
    this.updateLiveSql();
  }

  public addStatusPreset(): void {
    this.designerColumns.push({
      name: 'status',
      label: 'Status',
      sql_type: 'VARCHAR',
      col_type: 'string',
      length_precision: '50',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: true,
      default_type: 'CUSTOM',
      default_value: 'active',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'NO ACTION',
      user_touched_type: true
    });
    this.designerColumns.push({
      name: 'is_active',
      label: 'Active Flag',
      sql_type: 'BOOLEAN',
      col_type: 'boolean',
      length_precision: '',
      is_pk: false,
      is_required: false,
      is_unique: false,
      has_index: false,
      default_type: 'CUSTOM',
      default_value: '1',
      ref_table: '',
      ref_col: '_id',
      ref_select: [],
      on_delete: 'NO ACTION',
      user_touched_type: true
    });
    this.updateLiveSql();
  }

  public addAddressPreset(): void {
    const addressCols: Array<{ name: string; label: string; len: string }> = [
      { name: 'address_line', label: 'Address Line', len: '255' },
      { name: 'city', label: 'City', len: '100' },
      { name: 'state', label: 'State', len: '100' },
      { name: 'pincode', label: 'PIN / Zip Code', len: '20' }
    ];
    for (const a of addressCols) {
      this.designerColumns.push({
        name: a.name,
        label: a.label,
        sql_type: 'VARCHAR',
        col_type: 'string',
        length_precision: a.len,
        is_pk: false,
        is_required: false,
        is_unique: false,
        has_index: false,
        default_type: 'NONE',
        default_value: '',
        ref_table: '',
        ref_col: '_id',
        ref_select: [],
        on_delete: 'NO ACTION',
        user_touched_type: true
      });
    }
    this.updateLiveSql();
  }

  public updateLiveSql(): void {
    const tbl = SchemaHeuristicsUtil.sanitizeIdentifier(this.newTableName) || 'unnamed_table';
    const lines: string[] = ['  _id INTEGER PRIMARY KEY AUTOINCREMENT'];

    for (let i = 1; i < this.designerColumns.length; i++) {
      const c = this.designerColumns[i];
      const cName = SchemaHeuristicsUtil.sanitizeIdentifier(c.name);
      if (!cName) continue;

      let typeStr = c.sql_type;
      if (c.sql_type === 'FK') typeStr = 'INTEGER';
      if (c.sql_type === 'VARCHAR' && c.length_precision) typeStr = `VARCHAR(${c.length_precision})`;
      if (c.sql_type === 'DECIMAL' && c.length_precision) typeStr = `DECIMAL(${c.length_precision})`;

      let colLine = `  ${cName} ${typeStr}`;
      if (c.is_required) colLine += ' NOT NULL';
      if (c.is_unique) colLine += ' UNIQUE';

      if (c.default_type === 'CURRENT_TIMESTAMP') colLine += " DEFAULT (datetime('now', 'localtime'))";
      else if (c.default_type === 'NULL') colLine += ' DEFAULT NULL';
      else if (c.default_type === 'CUSTOM' && c.default_value !== '') {
        const isNum = ['INT', 'BIGINT', 'DECIMAL', 'BOOLEAN'].includes(c.sql_type);
        colLine += isNum ? ` DEFAULT ${c.default_value}` : ` DEFAULT '${c.default_value}'`;
      }

      if (c.sql_type === 'FK' && c.ref_table) {
        colLine += ` REFERENCES ${c.ref_table}(${c.ref_col || '_id'})`;
        if (c.on_delete && c.on_delete !== 'NO ACTION') {
          colLine += ` ON DELETE ${c.on_delete}`;
        }
      }
      lines.push(colLine);
    }

    this.liveSqlPreview = `CREATE TABLE ${tbl} (\n${lines.join(',\n')}\n);`;
  }

  public submitCreateTable(): void {
    const rawName = this.isEditMode
      ? this.editTableName!
      : SchemaHeuristicsUtil.sanitizeIdentifier(this.newTableName);
    if (!rawName) {
      alert('Please provide a valid table name');
      return;
    }

    const validCols = this.designerColumns.filter(c => c.is_pk || SchemaHeuristicsUtil.sanitizeIdentifier(c.name));
    if (validCols.length <= 1) {
      alert('Please add at least 1 custom column');
      return;
    }

    // Warn user before permanently dropping existing columns in Edit Mode
    if (this.isEditMode && this.originalColumnNames.length > 0) {
      const keptOriginals = new Set(validCols.map(c => c.original_name || c.name));
      const dropped = this.originalColumnNames.filter(n => !keptOriginals.has(n));
      if (dropped.length > 0) {
        const msg = `⚠️ Warning: You are removing ${dropped.length} column(s) (${dropped.join(', ')}) from "${rawName}" (${this.existingRowCount} row(s)). Data in removed columns will be permanently deleted.\n\nContinue saving changes?`;
        if (!window.confirm(msg)) return;
      }
    }

    const payload = {
      table_name: rawName,
      label: this.newTableLabel || rawName,
      description: this.newTableDesc || null,
      columns: validCols.map(c => ({
        column_name: c.is_pk ? '_id' : (SchemaHeuristicsUtil.sanitizeIdentifier(c.name) || c.name),
        original_name: c.original_name || null,
        label: c.label || c.name,
        col_type: c.col_type,
        sql_type: c.sql_type,
        length_precision: c.length_precision,
        is_pk: c.is_pk ? 1 : 0,
        is_required: c.is_required ? 1 : 0,
        is_unique: c.is_unique ? 1 : 0,
        has_index: c.has_index ? 1 : 0,
        default_type: c.default_type,
        default_value: c.default_type === 'CUSTOM'
          ? c.default_value
          : (c.default_type === 'CURRENT_TIMESTAMP' ? "datetime('now', 'localtime')" : null),
        ref_table: c.sql_type === 'FK' ? c.ref_table : null,
        ref_col: c.sql_type === 'FK' ? (c.ref_col || '_id') : null,
        ref_select: c.sql_type === 'FK' ? c.ref_select : null,
        on_delete: c.sql_type === 'FK' ? (c.on_delete || 'RESTRICT') : null
      }))
    };

    this.isCreatingTable = true;
    if (this.isEditMode) {
      const url = this.api
        ? this.api.buildApiUrl(`/api/_sutram/schema/tables/${encodeURIComponent(rawName)}`)
        : `/api/_sutram/schema/tables/${encodeURIComponent(rawName)}`;
      this.http.put<{ success: boolean; error?: string; message?: string }>(url, payload).subscribe({
        next: (res) => {
          this.isCreatingTable = false;
          if (res && res.success) {
            this.close();
            this.tableUpdated.emit(rawName);
          } else {
            alert('Error: ' + (res?.error || 'Could not update table'));
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isCreatingTable = false;
          alert('Error: ' + (err?.error?.error || err?.message || 'Server error'));
          this.cdr.markForCheck();
        }
      });
    } else {
      const url = this.api ? this.api.buildApiUrl('/api/_sutram/schema/create-table') : '/api/_sutram/schema/create-table';
      this.http.post<{ success: boolean; error?: string; message?: string }>(url, payload).subscribe({
        next: (res) => {
          this.isCreatingTable = false;
          if (res && res.success) {
            this.close();
            this.tableCreated.emit(rawName);
          } else {
            alert('Error: ' + (res?.error || 'Could not create table'));
          }
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isCreatingTable = false;
          alert('Error: ' + (err?.error?.error || err?.message || 'Server error'));
          this.cdr.markForCheck();
        }
      });
    }
  }
}

