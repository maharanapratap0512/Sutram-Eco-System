/**
 * project.model.ts
 * ─────────────────────────────────────────────────────────────
 * TypeScript models for Sutram Multi-Project Workspace Architecture.
 * ─────────────────────────────────────────────────────────────
 */

export interface ProjectItem {
  _id: number;
  project_name: string;
  project_slug: string;
  db_file: string;
  db_path: string;
  description?: string;
  color?: string;
  icon?: string;
  owner_username?: string;
  active: number;
  created_at: string;
  updated_at: string;
  file_size?: number;
  tables_count?: number;
  is_online?: boolean;
  is_cached?: boolean;
  members_count?: number;
  access_role?: 'owner' | 'member' | 'viewer';
  db_type?: 'sqlite' | 'mysql';
  db_config?: string | any;
  mysql_database?: string;
}

export interface MasterUser {
  _id: number;
  username: string;
  display_name?: string;
  role: 'superadmin' | 'admin' | 'user';
  can_create_project?: number;
  token?: string;
  active: number;
  created_at: string;
}

export interface ProjectMember {
  access_id: number;
  user_id: number;
  username: string;
  display_name?: string;
  master_role: string;
  access_role: 'owner' | 'member' | 'viewer';
  created_at: string;
}

export interface InProjectUser {
  _id: number;
  username: string;
  password?: string;
  display_name?: string;
  role: 'admin' | 'author';
  active: number;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectCreatePayload {
  name: string;
  description?: string;
  password?: string;
  username?: string;
  color?: string;
  icon?: string;
  createdBy?: string;
  dbSource?: 'blank' | 'upload' | 'mysql';
  tempFileKey?: string;
  db_type?: 'sqlite' | 'mysql';
  mysql_config?: {
    host: string;
    port?: number;
    user: string;
    password?: string;
    database: string;
    create_if_missing?: boolean;
    clone?: boolean;
    clone_source_db?: string;
  };
}

export interface MySqlDatabaseItem {
  name: string;
  isSutram: boolean;
  tableCount: number;
}

export interface DbInspectionReport {
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  isSutramDB: boolean;
  engineVersion: number;
  tablesCount: number;
  tables: Array<{
    name: string;
    rowCount: number;
    columnsCount: number;
    foreignKeysCount: number;
  }>;
}

