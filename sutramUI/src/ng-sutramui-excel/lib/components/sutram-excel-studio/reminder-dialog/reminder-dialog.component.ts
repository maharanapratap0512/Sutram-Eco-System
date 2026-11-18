import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, ChangeDetectorRef, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { SutramExcelApiService } from '../../../services/sutram-excel-api.service';

@Component({
  selector: 'sutram-reminder-dialog',
  templateUrl: './reminder-dialog.component.html',
  styleUrls: ['./reminder-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ReminderDialogComponent implements OnInit, OnChanges {
  @Input() visible: boolean = false;
  @Input() isDarkMode: boolean = false;
  @Input() rules: any[] = [];
  @Input() isSaving: boolean = false;
  @Input() tablesList: Array<{ table?: string; name?: string; display_name?: string; label?: string }> = [];
  @Input() currentTableName: string = '';

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() createRule = new EventEmitter<any>();
  @Output() updateRule = new EventEmitter<{ id: number; data: any }>();
  @Output() deleteRule = new EventEmitter<number>();
  @Output() evaluateAll = new EventEmitter<void>();
  @Output() openIncomingRemindersSheet = new EventEmitter<void>();

  // Default to list view of configured rules
  public activeTab: 'list' | 'create' = 'list';
  public showEntryModal: boolean = false;
  public editingRuleId: number | null = null;
  public isLoadingTargetColumns: boolean = false;
  public availableTargetColumns: Array<{ name: string; label: string; type: string }> = [];

  // Concrete stable array properties for PrimeNG dropdowns (NOT getters to prevent DOM re-renders on hover/click)
  public tableDropdownOptions: Array<{ label: string; value: string }> = [];
  public columnDropdownOptions: Array<{ label: string; value: string; type: string }> = [];
  public operatorDropdownOptions: Array<{ label: string; value: string }> = [];

  public frequencyOptions = [
    { label: '📅 Daily Once (दिन में एक बार)', value: 'daily_once' },
    { label: '⚡ Realtime Watchdog (डेटा बदलाव पर तुरंत)', value: 'on_mutation' },
    { label: '🔁 Hourly Check (हर घंटे)', value: 'hourly' },
    { label: '📌 Permanent / Always Active (स्थायी चेतावनी)', value: 'permanent' }
  ];

  public testResultPreview = {
    loading: false,
    tested: false,
    count: 0,
    sampleRecords: [] as any[],
    message: '',
    hasError: false,
    errorText: ''
  };

  public newReminder = {
    rule_name: '',
    reminder_type: 'smart_watchdog' as 'smart_watchdog' | 'normal',
    severity: 'warning' as 'info' | 'warning' | 'critical',
    is_permanent: false,
    target_table: '',
    target_column: '',
    col_type: '',
    operator: '',
    operand_value: '',
    date_condition_type: 'before_days',
    date_days: 15,
    schedule_time: '09:00',
    frequency: 'daily_once',
    catch_up_if_missed: true,
    message_template: '',
    notes: '',
    target_datetime: ''
  };

  constructor(
    private api: SutramExcelApiService,
    private cdr: ChangeDetectorRef
  ) {}

  public updateTableDropdownOptions(): void {
    if (!this.tablesList || !Array.isArray(this.tablesList)) {
      this.tableDropdownOptions = [];
      return;
    }
    this.tableDropdownOptions = this.tablesList
      .map(t => {
        const tblName = t.table || t.name || '';
        const disp = t.display_name || t.label || tblName;
        return {
          label: disp && disp !== tblName ? `${disp} (${tblName})` : tblName,
          value: tblName
        };
      })
      .filter(t => t.value && !t.value.startsWith('sys_'));
  }

  public updateColumnDropdownOptions(): void {
    if (!this.availableTargetColumns || !Array.isArray(this.availableTargetColumns)) {
      this.columnDropdownOptions = [];
      return;
    }
    this.columnDropdownOptions = this.availableTargetColumns.map(c => ({
      label: `${c.label || c.name} [${(c.type || 'text').toUpperCase()}]`,
      value: c.name,
      type: c.type
    }));
  }

  public updateOperatorDropdownOptions(): void {
    const type = (this.newReminder.col_type || '').toLowerCase();
    if (type === 'number') {
      this.operatorDropdownOptions = [
        { label: '< Less than (से कम होने पर)', value: '<' },
        { label: '<= Less than or equal (से कम या बराबर)', value: '<=' },
        { label: '> Greater than (से अधिक होने पर)', value: '>' },
        { label: '>= Greater than or equal (से अधिक या बराबर)', value: '>=' },
        { label: '= Equals (सटीक बराबर)', value: '=' },
        { label: '!= Not Equals (बराबर न होने पर)', value: '!=' }
      ];
    } else if (type === 'date') {
      this.operatorDropdownOptions = [
        { label: '📅 Due / Expiring in next X days (अगले X दिनों में)', value: 'before_days' },
        { label: '⏳ Overdue by X days (X दिन बीत जाने पर)', value: 'after_days' },
        { label: '⚠️ Overdue / Past Date (आज से पुरानी तारीख)', value: 'is_past' },
        { label: '🎯 Exactly Today (आज की तारीख पर)', value: 'is_today' }
      ];
    } else if (type === 'boolean') {
      this.operatorDropdownOptions = [
        { label: '✓ Is TRUE / Active (हाँ / सक्रिय होने पर)', value: '= 1' },
        { label: '✗ Is FALSE / Inactive (ना / निष्क्रिय होने पर)', value: '= 0' }
      ];
    } else {
      this.operatorDropdownOptions = [
        { label: '= Equals (सटीक मिलान)', value: '=' },
        { label: '!= Not Equals (अलग होने पर)', value: '!=' },
        { label: '🔍 Contains text (शब्द शामिल होने पर)', value: 'contains' },
        { label: '⚠️ Is Empty / Blank (खाली होने पर)', value: 'is_empty' }
      ];
    }
  }

  ngOnInit(): void {
    this.updateTableDropdownOptions();
    this.initDefaultReminder();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tablesList']) {
      this.updateTableDropdownOptions();
    }
    if (changes['visible'] && this.visible) {
      this.activeTab = 'list';
      this.showEntryModal = false;
      this.testResultPreview.tested = false;
      this.updateTableDropdownOptions();
    }
  }

  public initDefaultReminder(): void {
    this.editingRuleId = null;
    this.availableTargetColumns = [];
    this.columnDropdownOptions = [];
    this.operatorDropdownOptions = [];
    this.newReminder = {
      rule_name: '',
      reminder_type: 'smart_watchdog',
      severity: 'warning',
      is_permanent: false,
      target_table: '',
      target_column: '',
      col_type: '',
      operator: '',
      operand_value: '',
      date_condition_type: 'before_days',
      date_days: 15,
      schedule_time: '09:00',
      frequency: 'daily_once',
      catch_up_if_missed: true,
      message_template: '',
      notes: '',
      target_datetime: ''
    };
    this.updateTableDropdownOptions();
    this.updateOperatorDropdownOptions();
    this.testResultPreview.tested = false;
    this.cdr.detectChanges();
  }

  public openCreateEntry(): void {
    this.initDefaultReminder();
    this.updateTableDropdownOptions();
    this.showEntryModal = true;
    this.cdr.detectChanges();
  }

  public closeEntryModal(): void {
    this.showEntryModal = false;
    this.cdr.detectChanges();
  }

  public setReminderType(type: 'smart_watchdog' | 'normal'): void {
    this.newReminder.reminder_type = type;
    this.autoGenerateReminderMessage();
    this.cdr.detectChanges();
  }

  public setReminderSeverity(sev: 'info' | 'warning' | 'critical'): void {
    this.newReminder.severity = sev;
    this.cdr.detectChanges();
  }

  public loadTargetTableColumns(tblName: string, selectColumn?: string): void {
    if (!tblName) {
      this.availableTargetColumns = [];
      this.columnDropdownOptions = [];
      this.isLoadingTargetColumns = false;
      this.cdr.detectChanges();
      return;
    }
    this.isLoadingTargetColumns = true;
    this.cdr.detectChanges();
    this.api.getTableConfig(tblName).subscribe({
      next: (cfg) => {
        this.isLoadingTargetColumns = false;
        const headers = cfg?.headers || [];
        const cols: Array<{ name: string; label: string; type: string }> = [];

        headers.forEach(h => {
          const colName = h.col_name || h.name;
          if (!colName || colName === '_id' || colName.includes('_by_dept_id') || colName === 'verify' || colName === 'hl') return;
          cols.push({
            name: colName,
            label: (h as any).display_name || (h as any).label || (h as any).name || colName,
            type: (h.type || 'string').toLowerCase()
          });
        });

        this.availableTargetColumns = cols;
        this.updateColumnDropdownOptions();

        if (selectColumn && cols.some(c => c.name === selectColumn)) {
          this.onReminderColChange(selectColumn);
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.isLoadingTargetColumns = false;
        this.availableTargetColumns = [];
        this.columnDropdownOptions = [];
        this.cdr.detectChanges();
      }
    });
  }

  public onReminderTableChange(event: any): void {
    const val = event?.value !== undefined ? event.value : event;
    this.newReminder.target_table = val || '';
    this.newReminder.target_column = '';
    this.newReminder.col_type = '';
    this.newReminder.operator = '';
    this.newReminder.operand_value = '';
    this.availableTargetColumns = [];
    this.columnDropdownOptions = [];
    this.operatorDropdownOptions = [];
    this.testResultPreview.tested = false;

    if (val) {
      this.loadTargetTableColumns(val);
    }
    this.autoGenerateReminderMessage();
    this.cdr.detectChanges();
  }

  public onReminderColChange(event: any): void {
    const colName = event?.value !== undefined ? event.value : event;
    this.newReminder.target_column = colName || '';
    if (!colName) {
      this.newReminder.col_type = '';
      this.newReminder.operator = '';
      this.newReminder.operand_value = '';
      this.operatorDropdownOptions = [];
      this.cdr.detectChanges();
      return;
    }

    const colDef = this.availableTargetColumns.find(c => c.name === colName);
    if (colDef) {
      const t = (colDef.type || '').toLowerCase();
      if (t === 'number' || t === 'int' || t === 'integer' || t === 'real' || t === 'float') {
        this.newReminder.col_type = 'number';
        this.newReminder.operator = '<';
        this.newReminder.operand_value = '20';
      } else if (t === 'date' || t === 'datetime' || t === 'timestamp') {
        this.newReminder.col_type = 'date';
        this.newReminder.date_condition_type = 'before_days';
        this.newReminder.operator = 'before_days';
        this.newReminder.date_days = 15;
      } else if (t === 'boolean' || t === 'bool') {
        this.newReminder.col_type = 'boolean';
        this.newReminder.operator = '= 1';
        this.newReminder.operand_value = '1';
      } else {
        this.newReminder.col_type = 'string';
        this.newReminder.operator = '=';
        this.newReminder.operand_value = '';
      }
    }
    this.updateOperatorDropdownOptions();
    this.autoGenerateReminderMessage();
    this.testResultPreview.tested = false;
    this.cdr.detectChanges();
  }

  public onOperatorChange(event: any): void {
    const op = event?.value !== undefined ? event.value : event;
    this.newReminder.operator = op;
    if (this.newReminder.col_type === 'date') {
      this.newReminder.date_condition_type = op;
    }
    this.autoGenerateReminderMessage();
    this.cdr.detectChanges();
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

    if (!this.newReminder.target_table) {
      return 'कृपया पहले तालिका चुनें। (Please select Table first)';
    }
    if (!this.newReminder.target_column) {
      return `तालिका "${this.newReminder.target_table}" चुनी गई है। कृपया नजर रखने के लिए एक कॉलम चुनें। (Select Column)`;
    }

    const tbl = this.newReminder.target_table;
    const col = this.newReminder.target_column;

    if (this.newReminder.col_type === 'number') {
      const op = this.newReminder.operator || '<';
      const val = this.newReminder.operand_value ?? '0';
      const opText = op === '<' ? 'कम' : (op === '<=' ? 'कम या बराबर' : (op === '>' ? 'अधिक' : (op === '>=' ? 'अधिक या बराबर' : (op === '=' ? 'बराबर' : 'अलग'))));
      return `जब भी ${tbl}.${col} का मान ${val} से ${opText} होगा, यह वॉचडॉग तुरंत अलर्ट करेगा।`;
    }

    if (this.newReminder.col_type === 'date') {
      const cond = this.newReminder.operator || this.newReminder.date_condition_type;
      const days = this.newReminder.date_days || 0;
      if (cond === 'before_days') return `तारीख ${tbl}.${col} आने से ${days} दिन पहले आपको अलर्ट मिलेगा।`;
      if (cond === 'after_days') return `तारीख ${tbl}.${col} के ${days} दिन बीत जाने पर अलर्ट मिलेगा।`;
      if (cond === 'is_past') return `जब ${tbl}.${col} की तारीख आज से पुरानी (Overdue/Expired) हो जाएगी, तो तुरंत अलर्ट मिलेगा।`;
      if (cond === 'is_today') return `जब ${tbl}.${col} की तारीख आज की होगी, तो उसी दिन अलर्ट मिलेगा।`;
      return `तारीख शर्त पर अलर्ट मिलेगा।`;
    }

    if (this.newReminder.col_type === 'boolean') {
      const isTrue = this.newReminder.operator === '= 1';
      return `जब भी ${tbl}.${col} का मान ${isTrue ? 'हाँ / TRUE' : 'ना / FALSE'} होगा, यह वॉचडॉग अलर्ट करेगा।`;
    }

    if (this.newReminder.operator === 'is_empty') {
      return `जब भी ${tbl}.${col} खाली (Blank/Empty) होगा, यह वॉचडॉग अलर्ट करेगा।`;
    }

    return `जब भी ${tbl}.${col} "${this.newReminder.operator}" "${this.newReminder.operand_value || ''}" होगा, यह वॉचडॉग अलर्ट करेगा।`;
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
    let op = this.newReminder.operator;
    let operandVal = this.newReminder.operand_value;

    if (isWatchdog && this.newReminder.col_type === 'date') {
      op = this.newReminder.operator || this.newReminder.date_condition_type;
      if (op === 'before_days' || op === 'after_days') {
        operandVal = String(this.newReminder.date_days || 15);
      } else {
        operandVal = '0';
      }
    } else if (isWatchdog && this.newReminder.col_type === 'boolean') {
      operandVal = op === '= 1' ? '1' : '0';
    }

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
      operator: isWatchdog ? op : null,
      operand_value: isWatchdog ? String(operandVal ?? '') : null,
      schedule_time: this.newReminder.schedule_time || null,
      frequency: this.newReminder.frequency || 'daily_once',
      catch_up_if_missed: this.newReminder.catch_up_if_missed ? 1 : 0,
      message_template: this.newReminder.message_template || (isWatchdog ? `Alert on [${this.newReminder.target_column}]` : 'Reminder notification'),
      active: 1
    };
  }

  public onSaveClick(): void {
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
      this.updateRule.emit({ id: this.editingRuleId, data: payload });
    } else {
      this.createRule.emit(payload);
    }

    this.showEntryModal = false;
    this.cdr.detectChanges();
  }

  public onEditRule(rule: any): void {
    this.editingRuleId = rule._id;
    this.newReminder = {
      rule_name: rule.rule_name || '',
      reminder_type: rule.reminder_type || 'smart_watchdog',
      severity: rule.severity || 'warning',
      is_permanent: !!rule.is_permanent,
      target_table: rule.target_table || '',
      target_column: rule.target_column || '',
      col_type: rule.col_type || 'number',
      operator: rule.operator || '<',
      operand_value: rule.operand_value ?? '20',
      date_condition_type: (['before_days', 'after_days', 'is_today', 'is_overdue'].includes(rule.operator) ? rule.operator : 'before_days'),
      date_days: parseInt(rule.operand_value, 10) || 15,
      schedule_time: rule.schedule_time || '09:00',
      frequency: rule.frequency || 'daily_once',
      catch_up_if_missed: rule.catch_up_if_missed !== 0,
      message_template: rule.message_template || '',
      notes: rule.notes || '',
      target_datetime: rule.target_datetime || ''
    };

    this.updateTableDropdownOptions();
    this.updateOperatorDropdownOptions();

    if (rule.target_table) {
      this.loadTargetTableColumns(rule.target_table, rule.target_column);
    }
    this.testResultPreview.tested = false;
    this.showEntryModal = true;
    this.cdr.detectChanges();
  }

  public onToggleRuleActive(rule: any): void {
    const newStatus = rule.active ? 0 : 1;
    this.updateRule.emit({ id: rule._id, data: { active: newStatus } });
  }

  public onDeleteRule(rule: any): void {
    if (confirm(`क्या आप नियम "${rule.rule_name}" को हटाना चाहते हैं?`)) {
      this.deleteRule.emit(rule._id);
    }
  }

  public onTestExistingRule(rule: any): void {
    this.api.testReminderRule(rule).subscribe({
      next: (res: any) => {
        const count = res?.result?.count ?? 0;
        alert(`Rule: "${rule.rule_name}"\nMatching rows right now: ${count}`);
      },
      error: (err: any) => {
        alert('Test error: ' + (err?.error?.error || err.message));
      }
    });
  }

  public onOpenIncomingSheetClick(): void {
    this.openIncomingRemindersSheet.emit();
    this.onClose();
  }

  public onTriggerEvaluateAll(): void {
    this.evaluateAll.emit();
  }

  public onClose(): void {
    this.visible = false;
    this.showEntryModal = false;
    this.visibleChange.emit(false);
  }
}
