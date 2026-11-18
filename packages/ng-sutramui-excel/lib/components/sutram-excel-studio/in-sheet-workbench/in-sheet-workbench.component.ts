import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, OnInit, OnChanges, SimpleChanges, ChangeDetectorRef } from '@angular/core';
import { SutramExcelApiService } from '../../../services/sutram-excel-api.service';

export interface InSheetUiSutra {
  target_col: string;
  display_name?: string;
  formula: string;
  is_temp: boolean;
}

export interface InSheetDbTrigger {
  _id?: any;
  trigger_name: string;
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  action_type: 'raw_sql' | 'update_row' | 'insert_row' | 'delete_row';
  raw_sql?: string;
  target_table?: string;
  field_map_str?: string;
  actions?: any[];
}

@Component({
  selector: 'sutram-in-sheet-workbench',
  templateUrl: './in-sheet-workbench.component.html',
  styleUrls: ['./in-sheet-workbench.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.dark-mode]': 'isDarkMode'
  }
})
export class InSheetWorkbenchComponent implements OnInit, OnChanges {
  @Input() isDarkMode: boolean = false;
  @Input() tool: 'ui_sutras' | 'db_triggers' | 'reminders' | null = null;
  @Input() tableName: string = '';
  @Input() tableTitle: string = '';
  @Input() isAdmin: boolean = true;

  // UI Sutras Inputs
  @Input() uiSutrasList: InSheetUiSutra[] = [];
  @Input() targetColOptions: { label: string; value: string; is_temp?: boolean }[] = [];
  @Input() currentTableColumns: any[] = [];
  @Input() referenceColumns: any[] = [];
  @Input() isSavingUiSutras: boolean = false;

  // DB Triggers Inputs
  @Input() dbTriggersList: InSheetDbTrigger[] = [];
  @Input() tablesList: Array<{ table: string; display_name: string }> = [];
  @Input() visibleHeaders: any[] = [];

  // Reminders Inputs & Outputs
  @Input() reminderRulesList: any[] = [];
  @Input() isSavingReminderRule: boolean = false;
  @Output() createReminderRule = new EventEmitter<any>();
  @Output() updateReminderRule = new EventEmitter<any>();
  @Output() deleteReminderRule = new EventEmitter<any>();
  @Output() testReminderRule = new EventEmitter<any>();
  @Output() evaluateAllReminders = new EventEmitter<void>();
  @Output() openFullSheet = new EventEmitter<void>();

  // General Outputs
  @Output() close = new EventEmitter<void>();
  @Output() addUiSutra = new EventEmitter<InSheetUiSutra>();
  @Output() removeUiSutra = new EventEmitter<number>();
  @Output() saveUiSutras = new EventEmitter<void>();

  @Output() createDbTrigger = new EventEmitter<InSheetDbTrigger>();
  @Output() deleteDbTrigger = new EventEmitter<any>();

  // Internal state for UI Sutra
  public selectedTargetColValue: string = '';
  public newUiSutra: InSheetUiSutra = { target_col: '', display_name: '', formula: '', is_temp: false };

  // Internal state for DB Trigger
  public newTriggerDef: InSheetDbTrigger = {
    trigger_name: '',
    event: 'INSERT',
    action_type: 'raw_sql',
    raw_sql: '',
    target_table: '',
    field_map_str: ''
  };

  public triggerEventOptions = [
    { label: 'INSERT (नई पंक्ति)', value: 'INSERT' },
    { label: 'UPDATE (संशोधन)', value: 'UPDATE' },
    { label: 'DELETE (विलोपन)', value: 'DELETE' }
  ];

  public triggerActionOptions = [
    { label: '⚡ Raw SQL (कस्टम SQL — अनुशंसित)', value: 'raw_sql' },
    { label: '🔄 Update Row (अन्य तालिका अपडेट)', value: 'update_row' },
    { label: '➕ Insert Row (अन्य तालिका में इन्सर्ट)', value: 'insert_row' },
    { label: '❌ Delete Row (अन्य तालिका से विलोपन)', value: 'delete_row' }
  ];

  // ── Reminders & Smart Watchdog Internal State ────────────────
  public reminderViewMode: 'create' | 'list' = 'create';
  public editingRuleId: any = null;
  public availableTargetColumns: Array<{ name: string; label: string; type: string }> = [];
  public isLoadingTargetColumns: boolean = false;

  public newReminder = {
    rule_name: '',
    reminder_type: 'smart_watchdog' as 'smart_watchdog' | 'normal',
    severity: 'warning' as 'info' | 'warning' | 'critical',
    is_permanent: false,
    target_table: '',
    target_column: '',
    col_type: 'number' as 'number' | 'date' | 'string' | 'boolean',
    operator: '<',
    operand_value: '20',
    date_condition_type: 'before_days' as 'before_days' | 'is_today' | 'is_overdue' | 'after_days',
    date_days: 15,
    schedule_time: '09:00',
    frequency: 'daily_once',
    catch_up_if_missed: true,
    message_template: '',
    notes: '',
    target_datetime: ''
  };

  public numberOperatorOptions = [
    { label: '<  कम होने पर (Less than)', value: '<' },
    { label: '<= कम या बराबर (Less or Equal)', value: '<=' },
    { label: '>  अधिक होने पर (Greater than)', value: '>' },
    { label: '>= अधिक या बराबर (Greater or Equal)', value: '>=' },
    { label: '=  बराबर होने पर (Equal)', value: '=' },
    { label: '!= भिन्न होने पर (Not Equal)', value: '!=' }
  ];

  public dateConditionOptions = [
    { label: '📅 Before Days (एक्सपायरी या तारीख से इतने दिन पहले)', value: 'before_days' },
    { label: '⏰ On Date (उसी दिन - Is Today)', value: 'is_today' },
    { label: '⚠️ Overdue / Expired (तारीख निकल जाने पर)', value: 'is_overdue' },
    { label: '📅 After Days (तारीख के इतने दिन बाद)', value: 'after_days' }
  ];

  public stringOperatorOptions = [
    { label: '= बराबर (Equals)', value: 'equals' },
    { label: '🔍 शामिल हो (Contains)', value: 'contains' },
    { label: '!= भिन्न हो (Not Equals)', value: 'not_equals' }
  ];

  public frequencyOptions = [
    { label: '📅 रोजाना एक बार (Daily once)', value: 'daily_once' },
    { label: '⚡ सिर्फ एक बार (Once only)', value: 'once' },
    { label: '🔄 डेटा बदलते ही (On mutation)', value: 'on_mutation' },
    { label: '⏱️ हर घंटे (Hourly)', value: 'hourly' }
  ];

  public testResultPreview = {
    tested: false,
    loading: false,
    count: 0,
    sampleRecords: [] as any[],
    message: '',
    hasError: false,
    errorText: ''
  };

  constructor(
    private api: SutramExcelApiService,
    private cdr: ChangeDetectorRef
  ) {}

  public ngOnInit(): void {
    this.initReminderDefaults();
  }

  public ngOnChanges(changes: SimpleChanges): void {
    if (changes['tool'] && changes['tool'].currentValue === 'reminders') {
      this.initReminderDefaults();
      if (this.reminderRulesList && this.reminderRulesList.length > 0 && !this.editingRuleId) {
        this.reminderViewMode = 'list';
      } else if (!this.editingRuleId) {
        this.reminderViewMode = 'create';
      }
    }
    if (changes['tableName'] && this.tool === 'reminders' && !this.editingRuleId) {
      if (this.tableName && !this.tableName.startsWith('sys_') && this.tableName !== 'blank') {
        this.newReminder.target_table = this.tableName;
        this.loadTargetTableColumns(this.newReminder.target_table);
      }
    }
  }

  private initReminderDefaults(): void {
    if (!this.newReminder.target_table) {
      if (this.tableName && !this.tableName.startsWith('sys_') && this.tableName !== 'blank') {
        this.newReminder.target_table = this.tableName;
      } else if (this.tablesList && this.tablesList.length > 0) {
        const found = this.tablesList.find(t => !t.table.startsWith('sys_'));
        this.newReminder.target_table = found ? found.table : this.tablesList[0].table;
      }
    }
    if (this.newReminder.target_table) {
      this.loadTargetTableColumns(this.newReminder.target_table);
    }
    if (!this.newReminder.rule_name) {
      this.newReminder.rule_name = 'Smart Watchdog Alert';
    }
  }

  public setReminderViewMode(mode: 'create' | 'list'): void {
    this.reminderViewMode = mode;
    if (mode === 'create' && !this.editingRuleId) {
      this.resetReminderForm();
    }
    this.cdr.markForCheck();
  }

  public resetReminderForm(): void {
    this.editingRuleId = null;
    this.testResultPreview = {
      tested: false,
      loading: false,
      count: 0,
      sampleRecords: [],
      message: '',
      hasError: false,
      errorText: ''
    };
    this.newReminder = {
      rule_name: '',
      reminder_type: 'smart_watchdog',
      severity: 'warning',
      is_permanent: false,
      target_table: (this.tableName && !this.tableName.startsWith('sys_')) ? this.tableName : (this.tablesList[0]?.table || ''),
      target_column: '',
      col_type: 'number',
      operator: '<',
      operand_value: '20',
      date_condition_type: 'before_days',
      date_days: 15,
      schedule_time: '09:00',
      frequency: 'daily_once',
      catch_up_if_missed: true,
      message_template: '',
      notes: '',
      target_datetime: ''
    };
    if (this.newReminder.target_table) {
      this.loadTargetTableColumns(this.newReminder.target_table);
    }
  }

  public loadTargetTableColumns(tblName: string): void {
    if (!tblName) return;
    this.isLoadingTargetColumns = true;
    this.api.getTableConfig(tblName).subscribe({
      next: (cfg) => {
        this.isLoadingTargetColumns = false;
        const headers = cfg?.headers || [];
        const cols: Array<{ name: string; label: string; type: string }> = [];

        headers.forEach(h => {
          const colName = h.col_name || h.name;
          if (!colName || colName === '_id' || colName.includes('_by_dept_id') || colName === 'verify') return;
          cols.push({
            name: colName,
            label: (h as any).display_name || h.name || colName,
            type: (h.type || 'string').toLowerCase()
          });
        });

        this.availableTargetColumns = cols;

        // Select first column if none selected or not present
        if (!this.newReminder.target_column || !cols.some(c => c.name === this.newReminder.target_column)) {
          if (cols.length > 0) {
            const preferred = cols.find(c => c.type === 'number' || c.type === 'date') || cols[0];
            this.onReminderColChange(preferred.name);
          }
        }
        this.cdr.markForCheck();
      },
      error: () => {
        this.isLoadingTargetColumns = false;
        this.availableTargetColumns = [];
        this.cdr.markForCheck();
      }
    });
  }

  public onReminderTableChange(event: any): void {
    const val = event?.value !== undefined ? event.value : event;
    this.newReminder.target_table = val;
    this.loadTargetTableColumns(val);
  }

  public onReminderColChange(colName: string): void {
    this.newReminder.target_column = colName;
    const colDef = this.availableTargetColumns.find(c => c.name === colName);
    if (colDef) {
      const t = colDef.type.toLowerCase();
      if (t === 'number' || t === 'int' || t === 'integer' || t === 'real' || t === 'float') {
        this.newReminder.col_type = 'number';
        this.newReminder.operator = '<';
        if (!this.newReminder.operand_value || isNaN(Number(this.newReminder.operand_value))) {
          this.newReminder.operand_value = '20';
        }
      } else if (t === 'date' || t === 'datetime' || t === 'timestamp') {
        this.newReminder.col_type = 'date';
        this.newReminder.date_condition_type = 'before_days';
        this.newReminder.date_days = 15;
      } else {
        this.newReminder.col_type = 'string';
        this.newReminder.operator = 'equals';
      }
    }
    this.autoGenerateReminderMessage();
    this.testResultPreview.tested = false;
    this.cdr.markForCheck();
  }

  public setReminderType(type: 'smart_watchdog' | 'normal'): void {
    this.newReminder.reminder_type = type;
    this.autoGenerateReminderMessage();
    this.cdr.markForCheck();
  }

  public setReminderSeverity(sev: 'info' | 'warning' | 'critical'): void {
    this.newReminder.severity = sev;
    this.cdr.markForCheck();
  }

  public autoGenerateReminderMessage(): void {
    if (this.newReminder.reminder_type === 'smart_watchdog') {
      const col = this.newReminder.target_column || 'value';
      const tbl = this.newReminder.target_table || 'item';
      if (this.newReminder.col_type === 'number') {
        this.newReminder.message_template = `Warning: ${col} alert on [name]! Current: [${col}]`;
      } else if (this.newReminder.col_type === 'date') {
        this.newReminder.message_template = `Warning: ${col} expiry/due date approaching for [name] on [${col}]!`;
      } else {
        this.newReminder.message_template = `Alert: ${col} changed to [${col}] on ${tbl}!`;
      }
    } else {
      this.newReminder.message_template = this.newReminder.rule_name ? `Reminder: ${this.newReminder.rule_name}` : 'Task reminder';
    }
  }

  public insertTokenIntoMessage(token: string): void {
    if (!token) return;
    this.newReminder.message_template = (this.newReminder.message_template || '') + ` [${token}]`;
  }

  public getConditionExplanation(): string {
    if (this.newReminder.reminder_type === 'normal') {
      const dt = this.newReminder.target_datetime ? this.newReminder.target_datetime.replace('T', ' ') : 'निर्धारित तिथि व समय';
      return `यह अलार्म "${dt}" पर आपको "${this.newReminder.rule_name || 'रिमाइंडर'}" का नोटिफिकेशन दिखाएगा।`;
    }

    const tbl = this.newReminder.target_table || 'तालिका';
    const col = this.newReminder.target_column || 'कॉलम';

    if (this.newReminder.col_type === 'number') {
      const op = this.newReminder.operator || '<';
      const val = this.newReminder.operand_value ?? '0';
      const opText = op === '<' ? 'कम' : (op === '<=' ? 'कम या बराबर' : (op === '>' ? 'अधिक' : (op === '>=' ? 'अधिक या बराबर' : 'बराबर')));
      return `जब भी [${tbl}.${col}] का मान ${val} से ${opText} होगा, यह वॉचडॉग तुरंत अलर्ट करेगा।`;
    }

    if (this.newReminder.col_type === 'date') {
      const dtType = this.newReminder.date_condition_type;
      const days = this.newReminder.date_days || 15;
      if (dtType === 'before_days') {
        return `जब भी [${tbl}.${col}] की तारीख में ${days} दिन या कम बचेंगे, यह वॉचडॉग अलर्ट करेगा।`;
      }
      if (dtType === 'is_today') {
        return `जिस दिन [${tbl}.${col}] की तारीख होगी, उसी दिन यह वॉचडॉग अलर्ट करेगा।`;
      }
      if (dtType === 'is_overdue') {
        return `जब भी [${tbl}.${col}] की तारीख बीत जाएगी (Expired / Overdue), यह वॉचडॉग अलर्ट करेगा।`;
      }
      if (dtType === 'after_days') {
        return `जब [${tbl}.${col}] की तारीख बीते ${days} दिन हो जाएंगे, तब यह वॉचडॉग अलर्ट करेगा।`;
      }
    }

    if (this.newReminder.col_type === 'string') {
      return `जब भी [${tbl}.${col}] ${this.newReminder.operator === 'contains' ? 'में शामिल होगा' : 'बराबर होगा'} "${this.newReminder.operand_value || ''}", यह अलर्ट करेगा।`;
    }

    return `डेटाबेस रिकॉर्ड्स पर वॉचडॉग सक्रिय रहेगा।`;
  }

  public testReminderRuleLive(): void {
    if (this.newReminder.reminder_type === 'smart_watchdog') {
      if (!this.newReminder.target_table || !this.newReminder.target_column) {
        alert('कृपया तालिका और कॉलम चुनें (Please select table and column)');
        return;
      }
    }

    this.testResultPreview.loading = true;
    this.testResultPreview.tested = true;
    this.testResultPreview.hasError = false;

    const payload = this.buildRulePayload();

    this.api.testReminderRule(payload).subscribe({
      next: (res: any) => {
        this.testResultPreview.loading = false;
        const r = res?.result;
        this.testResultPreview.count = r?.count || 0;
        this.testResultPreview.sampleRecords = r?.sampleRecords || [];
        this.testResultPreview.message = r?.message || '';
        this.cdr.markForCheck();
      },
      error: (err: any) => {
        this.testResultPreview.loading = false;
        this.testResultPreview.hasError = true;
        this.testResultPreview.errorText = err?.error?.error || err.message || 'Test failed';
        this.cdr.markForCheck();
      }
    });
  }

  private buildRulePayload(): any {
    const isWatchdog = this.newReminder.reminder_type === 'smart_watchdog';
    return {
      rule_name: this.newReminder.rule_name || (isWatchdog ? `${this.newReminder.target_table}.${this.newReminder.target_column} Watchdog` : 'Task Reminder'),
      reminder_type: this.newReminder.reminder_type,
      severity: this.newReminder.severity,
      is_permanent: this.newReminder.is_permanent ? 1 : 0,
      target_datetime: this.newReminder.reminder_type === 'normal' ? this.newReminder.target_datetime : null,
      notes: this.newReminder.notes || null,
      target_table: isWatchdog ? this.newReminder.target_table : null,
      target_column: isWatchdog ? this.newReminder.target_column : null,
      col_type: isWatchdog ? this.newReminder.col_type : null,
      operator: isWatchdog ? (this.newReminder.col_type === 'date' ? this.newReminder.date_condition_type : this.newReminder.operator) : null,
      operand_value: isWatchdog ? (this.newReminder.col_type === 'date' ? String(this.newReminder.date_days) : String(this.newReminder.operand_value)) : null,
      schedule_time: this.newReminder.schedule_time || null,
      frequency: this.newReminder.frequency || 'daily_once',
      catch_up_if_missed: this.newReminder.catch_up_if_missed ? 1 : 0,
      message_template: this.newReminder.message_template || (isWatchdog ? `Alert on [${this.newReminder.target_column}]` : 'Reminder notification'),
      active: 1
    };
  }

  public onSaveReminderClick(): void {
    if (!this.newReminder.rule_name?.trim()) {
      alert('कृपया अनुस्मारक का नाम दर्ज करें (Please enter Rule Name)');
      return;
    }
    if (this.newReminder.reminder_type === 'smart_watchdog') {
      if (!this.newReminder.target_table || !this.newReminder.target_column) {
        alert('कृपया तालिका और कॉलम चुनें (Please select table and column)');
        return;
      }
    }

    const payload = this.buildRulePayload();

    if (this.editingRuleId) {
      this.updateReminderRule.emit({ id: this.editingRuleId, rule: payload });
    } else {
      this.createReminderRule.emit(payload);
    }

    this.resetReminderForm();
    this.reminderViewMode = 'list';
    this.cdr.markForCheck();
  }

  public onEditReminderRuleClick(rule: any): void {
    this.editingRuleId = rule._id;
    this.newReminder = {
      rule_name: rule.rule_name || '',
      reminder_type: rule.reminder_type || 'smart_watchdog',
      severity: rule.severity || 'warning',
      is_permanent: rule.is_permanent === 1 || rule.is_permanent === true,
      target_table: rule.target_table || '',
      target_column: rule.target_column || '',
      col_type: rule.col_type || 'number',
      operator: rule.operator || '<',
      operand_value: rule.operand_value || '',
      date_condition_type: (['before_days', 'is_today', 'is_overdue', 'after_days'].includes(rule.operator) ? rule.operator : 'before_days') as any,
      date_days: Number(rule.operand_value) || 15,
      schedule_time: rule.schedule_time || '09:00',
      frequency: rule.frequency || 'daily_once',
      catch_up_if_missed: rule.catch_up_if_missed !== 0,
      message_template: rule.message_template || '',
      notes: rule.notes || '',
      target_datetime: rule.target_datetime || ''
    };
    if (this.newReminder.target_table) {
      this.loadTargetTableColumns(this.newReminder.target_table);
    }
    this.reminderViewMode = 'create';
    this.cdr.markForCheck();
  }

  public onDeleteReminderRuleClick(id: any): void {
    if (confirm('क्या आप वाकई इस अनुस्मारक नियम को हटाना चाहते हैं? (Are you sure you want to delete this reminder rule?)')) {
      this.deleteReminderRule.emit(id);
    }
  }

  public onToggleRuleActiveClick(rule: any): void {
    const updated = {
      ...rule,
      active: (rule.active === 1 || rule.active === true) ? 0 : 1
    };
    this.updateReminderRule.emit({ id: rule._id, rule: updated });
  }

  public onTestExistingRuleClick(rule: any): void {
    this.api.testReminderRule(rule).subscribe({
      next: (res: any) => {
        const count = res?.result?.count || 0;
        const msg = res?.result?.message || '';
        alert(`डेटाबेस टेस्ट परिणाम:\n\n• मेल खाने वाले रिकॉर्ड्स: ${count}\n• संदेश: ${msg}`);
      },
      error: (err: any) => {
        alert('टेस्ट विफल रहा: ' + (err?.error?.error || err.message));
      }
    });
  }

  // ── UI Sutras Handlers ───────────────────────────────────────
  public onTargetColChange(event: any): void {
    const val = event?.value !== undefined ? event.value : event;
    this.selectedTargetColValue = val;
    if (val === '__NEW_TEMP_COL__') {
      this.newUiSutra.is_temp = true;
      this.newUiSutra.target_col = `temp_col_${Date.now()}`;
      if (!this.newUiSutra.display_name) {
        this.newUiSutra.display_name = '';
      }
    } else {
      this.newUiSutra.is_temp = false;
      this.newUiSutra.target_col = val;
      const opt = this.targetColOptions.find(o => o.value === val);
      this.newUiSutra.display_name = opt?.label || val;
    }
  }

  public insertColIntoFormula(colName: string): void {
    if (!colName) return;
    this.newUiSutra.formula = (this.newUiSutra.formula || '') + `[${colName}]`;
  }

  public insertFnIntoFormula(fnTemplate: string): void {
    if (!fnTemplate) return;
    this.newUiSutra.formula = (this.newUiSutra.formula || '') + fnTemplate;
  }

  public onAddUiSutraClick(): void {
    if (!this.selectedTargetColValue || !this.newUiSutra.formula?.trim()) return;
    if (this.newUiSutra.is_temp && !this.newUiSutra.display_name?.trim()) return;

    this.addUiSutra.emit({ ...this.newUiSutra });
    this.selectedTargetColValue = '';
    this.newUiSutra = { target_col: '', display_name: '', formula: '', is_temp: false };
  }

  public onRemoveUiSutraClick(index: number): void {
    this.removeUiSutra.emit(index);
  }

  public onSaveUiSutrasClick(): void {
    this.saveUiSutras.emit();
  }

  // ── DB Triggers Handlers ─────────────────────────────────────
  public insertColIntoTriggerSql(colName: string, prefix: ':new.' | ':old.'): void {
    if (!colName) return;
    this.newTriggerDef.raw_sql = (this.newTriggerDef.raw_sql || '') + `${prefix}${colName}`;
  }

  public insertTextIntoTriggerSql(text: string): void {
    if (!text) return;
    this.newTriggerDef.raw_sql = (this.newTriggerDef.raw_sql || '') + ` ${text} `;
  }

  public onCreateTriggerClick(): void {
    if (!this.newTriggerDef.trigger_name) return;
    if (this.newTriggerDef.action_type === 'raw_sql' && !this.newTriggerDef.raw_sql?.trim()) return;

    this.createDbTrigger.emit({ ...this.newTriggerDef });
    this.newTriggerDef = {
      trigger_name: '',
      event: 'INSERT',
      action_type: 'raw_sql',
      raw_sql: '',
      target_table: '',
      field_map_str: ''
    };
  }

  public onDeleteTriggerClick(id: any): void {
    this.deleteDbTrigger.emit(id);
  }

  public onCloseClick(): void {
    this.close.emit();
  }
}
