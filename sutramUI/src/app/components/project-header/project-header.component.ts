import { Component, Input, Output, EventEmitter } from '@angular/core';
import { ProjectItem } from '../../models/project.model';
import { ProjectContextService } from '../../services/project-context.service';
import { LanNetworkService } from '../../services/lan-network.service';

@Component({
  selector: 'app-project-header',
  templateUrl: './project-header.component.html',
  styleUrls: ['./project-header.component.scss']
})
export class ProjectHeaderComponent {
  @Input() projects: ProjectItem[] = [];
  @Input() activeProject: ProjectItem | null = null;
  @Input() showingHub: boolean = false;
  @Input() isServerOnline: boolean = true;
  @Input() serverPort: number = 3300;
  @Input() isDarkMode: boolean = false;

  @Output() selectProject = new EventEmitter<ProjectItem>();
  @Output() closeProject = new EventEmitter<ProjectItem>();
  @Output() goToHub = new EventEmitter<void>();
  @Output() toggleTheme = new EventEmitter<void>();
  @Output() logout = new EventEmitter<void>();
  @Output() openLanModal = new EventEmitter<void>();
  @Output() openUpdateModal = new EventEmitter<void>();
  @Output() emergencyReset = new EventEmitter<void>();

  constructor(
    public projectContext: ProjectContextService,
    public lanService: LanNetworkService
  ) {}

  public onSelectTab(p: ProjectItem): void {
    this.selectProject.emit(p);
  }

  public onCloseTab(p: ProjectItem, event: MouseEvent): void {
    event.stopPropagation();
    this.closeProject.emit(p);
  }
}
