import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { HttpClientModule, HTTP_INTERCEPTORS } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';

// PrimeNG Modules
import { DropdownModule } from 'primeng/dropdown';
import { MultiSelectModule } from 'primeng/multiselect';
import { CheckboxModule } from 'primeng/checkbox';
import { TooltipModule } from 'primeng/tooltip';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { CardModule } from 'primeng/card';
import { BadgeModule } from 'primeng/badge';
import { ContextMenuModule } from 'primeng/contextmenu';

// Sutram Excel Module
import { SutramExcelModule } from 'ng-sutramui-excel';

// Interceptors & Services
import { ProjectHttpInterceptor } from './interceptors/project.interceptor';

// Components
import { AppComponent } from './app.component';
import { ProjectHubComponent } from './components/project-hub/project-hub.component';
import { CreateProjectModalComponent } from './components/create-project-modal/create-project-modal.component';
import { ProjectHeaderComponent } from './components/project-header/project-header.component';
import { ProjectUsersModalComponent } from './components/project-users-modal/project-users-modal.component';
import { MasterUsersModalComponent } from './components/master-users-modal/master-users-modal.component';
import { MasterLoginComponent } from './components/master-login/master-login.component';
import { LanNetworkDialogComponent } from './components/lan-network-dialog/lan-network-dialog.component';
import { AppUpdaterDialogComponent } from './components/app-updater-dialog/app-updater-dialog.component';

@NgModule({
  declarations: [
    AppComponent,
    ProjectHubComponent,
    CreateProjectModalComponent,
    ProjectHeaderComponent,
    ProjectUsersModalComponent,
    MasterUsersModalComponent,
    MasterLoginComponent,
    LanNetworkDialogComponent,
    AppUpdaterDialogComponent
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    HttpClientModule,
    FormsModule,
    RouterModule.forRoot([]),
    DropdownModule,
    MultiSelectModule,
    CheckboxModule,
    TooltipModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    PasswordModule,
    TableModule,
    TagModule,
    CardModule,
    BadgeModule,
    ContextMenuModule,
    SutramExcelModule
  ],
  providers: [
    {
      provide: HTTP_INTERCEPTORS,
      useClass: ProjectHttpInterceptor,
      multi: true
    }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
