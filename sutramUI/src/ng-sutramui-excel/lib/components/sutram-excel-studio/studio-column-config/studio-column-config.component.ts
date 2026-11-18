import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy, ViewChild } from '@angular/core';
import { OverlayPanel } from 'primeng/overlaypanel';

export interface StudioConfigColumn {
  key: string;
  name: string;
  short_name?: string;
  col_name?: string;
  group?: string | null;
  type?: string;
  not_null?: boolean;
  default_selected?: boolean;
  is_fk_main?: boolean;
  is_fk_subcol?: boolean;
  is_fk_raw?: boolean;
  is_temp?: boolean;
  is_virtual?: boolean;
  readonly?: boolean;
  ref_table?: string;
  ref_as?: string;
  sub_col_name?: string;
  label?: string;
  display_format?: string;
}

export interface StudioFkGroup {
  name: string;
  refTable: string;
  columns: StudioConfigColumn[];
  totalCount: number;
  selectedCount: number;
  isAllChecked: boolean;
  isIndeterminate: boolean;
}

@Component({
  selector: 'sutram-studio-column-config',
  templateUrl: './studio-column-config.component.html',
  styleUrls: ['./studio-column-config.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class StudioColumnConfigComponent {
  @ViewChild('colConfigOp') public overlayPanel!: OverlayPanel;

  @Input() allConfigColumns: StudioConfigColumn[] = [];
  @Input() selectedColumnKeys: Set<string> = new Set();
  @Input() expandedFkGroups: Set<string> = new Set();

  @Output() columnToggled = new EventEmitter<string>();
  @Output() fkGroupAllToggled = new EventEmitter<string>();
  @Output() selectAll = new EventEmitter<boolean>();
  @Output() resetDefaults = new EventEmitter<void>();
  @Output() expandedFkGroupsChange = new EventEmitter<Set<string>>();

  public colSearchQuery: string = '';

  public get selectedVisibleCount(): number {
    return this.allConfigColumns.filter(c => this.selectedColumnKeys.has(c.key)).length;
  }

  public get filteredDirectCols(): StudioConfigColumn[] {
    const q = (this.colSearchQuery || '').trim().toLowerCase();
    return this.allConfigColumns.filter(c => {
      if (c.group) return false;
      if (!q) return true;
      return (c.name && c.name.toLowerCase().includes(q)) ||
             (c.short_name && c.short_name.toLowerCase().includes(q)) ||
             (c.label && c.label.toLowerCase().includes(q)) ||
             (c.key && c.key.toLowerCase().includes(q));
    });
  }

  public get filteredFkGroups(): StudioFkGroup[] {
    const q = (this.colSearchQuery || '').trim().toLowerCase();
    const groupsMap = new Map<string, StudioConfigColumn[]>();

    this.allConfigColumns.forEach(c => {
      if (c.group) {
        if (!groupsMap.has(c.group)) groupsMap.set(c.group, []);
        groupsMap.get(c.group)!.push(c);
      }
    });

    const result: StudioFkGroup[] = [];

    for (const [groupName, cols] of groupsMap.entries()) {
      const matchingCols = cols.filter(c => {
        if (!q) return true;
        return groupName.toLowerCase().includes(q) ||
               (c.name && c.name.toLowerCase().includes(q)) ||
               (c.short_name && c.short_name.toLowerCase().includes(q)) ||
               (c.label && c.label.toLowerCase().includes(q)) ||
               (c.key && c.key.toLowerCase().includes(q));
      });

      if (q && matchingCols.length === 0) continue;

      const selectedInGroup = cols.filter(c => this.selectedColumnKeys.has(c.key)).length;
      const totalInGroup = cols.length;

      result.push({
        name: groupName,
        refTable: cols[0]?.ref_table || groupName,
        columns: q ? matchingCols : cols,
        totalCount: totalInGroup,
        selectedCount: selectedInGroup,
        isAllChecked: selectedInGroup === totalInGroup && totalInGroup > 0,
        isIndeterminate: selectedInGroup > 0 && selectedInGroup < totalInGroup
      });
    }

    return result;
  }

  public toggle(event: any): void {
    if (this.overlayPanel) {
      this.overlayPanel.toggle(event);
    }
  }

  public hide(): void {
    if (this.overlayPanel) {
      this.overlayPanel.hide();
    }
  }

  public isColumnSelected(key: string): boolean {
    return this.selectedColumnKeys.has(key);
  }

  public onToggleColumn(key: string): void {
    this.columnToggled.emit(key);
  }

  public isFkGroupExpanded(groupName: string): boolean {
    if (this.colSearchQuery && this.colSearchQuery.trim()) return true;
    return this.expandedFkGroups.has(groupName);
  }

  public toggleFkGroupExpand(groupName: string): void {
    const newSet = new Set(this.expandedFkGroups);
    if (newSet.has(groupName)) {
      newSet.delete(groupName);
    } else {
      newSet.add(groupName);
    }
    this.expandedFkGroups = newSet;
    this.expandedFkGroupsChange.emit(this.expandedFkGroups);
  }

  public onToggleFkGroupAll(groupName: string): void {
    this.fkGroupAllToggled.emit(groupName);
  }

  public onSelectAll(val: boolean): void {
    this.selectAll.emit(val);
  }

  public onReset(): void {
    this.resetDefaults.emit();
  }

  public trackByColKey(index: number, col: StudioConfigColumn): string {
    return col.key;
  }

  public trackByGroupName(index: number, grp: StudioFkGroup): string {
    return grp.name;
  }
}
