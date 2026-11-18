import { Component, Input, Output, EventEmitter, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'sutram-unmask-dialog',
  templateUrl: './unmask-dialog.component.html',
  styleUrls: ['./unmask-dialog.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UnmaskDialogComponent {
  @Input() visible: boolean = false;
  @Input() tableName: string = '';
  @Input() columnName: string = '';
  @Input() targetType: 'column' | 'cell' = 'column';
  @Input() rowIdx?: number;
  @Input() isSubmitting: boolean = false;
  @Input() errorMessage: string = '';
  @Input() isAdmin: boolean = true;

  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() verify = new EventEmitter<{ table: string; column: string; secret: string }>();
  @Output() setPin = new EventEmitter<{ table: string; column: string; secret: string }>();

  public enteredSecret: string = '';
  public showPinSetter: boolean = false;
  public newPinSecret: string = '';

  public onCancel(): void {
    this.enteredSecret = '';
    this.errorMessage = '';
    this.showPinSetter = false;
    this.newPinSecret = '';
    this.visible = false;
    this.visibleChange.emit(false);
  }

  public onSubmit(): void {
    if (!this.enteredSecret || !this.enteredSecret.trim()) return;
    this.verify.emit({
      table: this.tableName,
      column: this.columnName,
      secret: this.enteredSecret.trim()
    });
  }

  public onSaveNewPin(): void {
    this.setPin.emit({
      table: this.tableName,
      column: this.columnName,
      secret: this.newPinSecret.trim()
    });
    this.showPinSetter = false;
    this.newPinSecret = '';
  }
}
