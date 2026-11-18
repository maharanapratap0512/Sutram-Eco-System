import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule } from '@angular/common/http';

// PrimeNG Modules
import { DialogModule } from 'primeng/dialog';
import { DropdownModule } from 'primeng/dropdown';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressBarModule } from 'primeng/progressbar';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

// Vision Components
import { SutramVisionDialogComponent } from './components/sutram-vision-dialog/sutram-vision-dialog.component';
import { SutramVisionWorkbenchComponent } from './components/sutram-vision-workbench/sutram-vision-workbench.component';
import { VisionScannerComponent } from './components/vision-scanner/vision-scanner.component';
import { VisionProfilesModalComponent } from './components/vision-profiles-modal/vision-profiles-modal.component';
import { VisionPreviewGridComponent } from './components/vision-preview-grid/vision-preview-grid.component';

// Services
import { SutramVisionApiService } from './services/sutram-vision-api.service';
import { SutramVisionProfileService } from './services/sutram-vision-profile.service';
import { SutramImageProcessorService } from './services/sutram-image-processor.service';

const COMPONENTS = [
  SutramVisionDialogComponent,
  SutramVisionWorkbenchComponent,
  VisionScannerComponent,
  VisionProfilesModalComponent,
  VisionPreviewGridComponent
];

@NgModule({
  declarations: [...COMPONENTS],
  imports: [
    CommonModule,
    FormsModule,
    HttpClientModule,
    DialogModule,
    DropdownModule,
    ButtonModule,
    InputTextModule,
    ProgressBarModule,
    CheckboxModule,
    TagModule,
    TooltipModule,
    TableModule,
    ToastModule
  ],
  providers: [
    MessageService,
    SutramVisionApiService,
    SutramVisionProfileService,
    SutramImageProcessorService
  ],
  exports: [...COMPONENTS, ToastModule]
})
export class SutramVisionModule {}
