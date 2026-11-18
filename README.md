# Sutram Dynamic ERP Platform (सूत्रम्)
## Universal, Schema-Oriented, Database-Agnostic Engine & Spreadsheet UI

---

## 1. Overview & Vision

**Sutram (सूत्रम् - Foundational Thread)** is a standalone, professional-grade, 100% database-agnostic universal ecosystem.
It allows building fully dynamic ERP applications **without writing boilerplate code or manual SQL tables**.

### Core Tenets:
1. **Zero Domain Hardcoding**: Completely decoupled from any specific business application. Works out-of-the-box on ANY SQLite or MySQL database (ERP, hospital, retail, logistics, university, CRM).
2. **Pure Schema-Oriented (Managed Mode)**: All table schemas, data types, constraints, UI layouts, and business triggers reside inside SQLite/MySQL system metadata tables (`sys_table`, `sys_column`, `sys_join`, `sys_table_ui`, `sys_column_ui`).
3. **Live Introspection & Stored Data Pattern Matching**: Automatically discovers tables, foreign keys, and relations directly from database schemas and data overlap.
4. **Resilient Spreadsheet UI (`sutramExcel` & `sutramUI`)**: Integrated PrimeNG spreadsheet interface with virtual scrolling, in-cell corrections, fuzzy header matching, multi-sheet tabs, live database filtering, and crash recovery.

---

## 2. Directory Structure

```
sutram/
├── package.json              # Root orchestration scripts
├── packages/                 # Core Sutram Ecosystem Packages
│   ├── sutramcore/           # Data Access Layer / Pure ORM (better-sqlite3)
│   ├── sutramcore-mysql/     # MySQL Data Access Adapter
│   ├── sutramEngine/         # Orchestrator, Trigger Pipeline & SchemaManager
│   ├── sutramExcel/          # Excel Ingestion, In-Memory Dictionaries & Router
│   └── ng-sutramui-excel/    # Angular / PrimeNG Spreadsheet Studio Component Library
├── sutramServer/             # Standalone Schema-Oriented Express Server
│   ├── package.json
│   ├── server.js             # Entry point (Port 3300)
│   ├── config/
│   │   └── server.config.js  # Port, database path, dialect configuration
│   └── data/
│       └── sutram-erp.db     # Standalone SQLite database (auto-created)
└── sutramUI/                 # Standalone Angular 16 Dynamic ERP Frontend
    ├── package.json
    ├── angular.json          # Angular CLI workspace configuration
    ├── proxy.conf.json       # Reverse proxy to sutramServer (Port 3300)
    ├── tsconfig.json         # Path-mapped to packages/ng-sutramui-excel
    └── src/
        ├── app/
        │   ├── app.module.ts # Imports SutramExcelModule directly
        │   ├── app.component.ts
        │   ├── app.component.html # ERP Topbar, Dynamic Table Modal & Excel Studio
        │   └── app.component.scss
        ├── main.ts
        └── styles.scss
```

---

## 3. Quick Start & Execution (Same as HisabKitab System)

### Step 1: Start Backend (`sutramServer`)
```bash
cd sutram/sutramServer
npm start
```
- Pure API Backend running at: **`http://localhost:3300`**

### Step 2: Start Frontend (`sutramUI` Angular Application)
```bash
cd sutram/sutramUI
npm start
```
- Full Angular ERP Application running at: **`http://localhost:4300`**
- All API and Excel calls are automatically proxied to `sutramServer` via `proxy.conf.json`!

---

## 4. Key Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Server status, database mode, active tables |
| `GET` | `/_sutram/excel/studio/` | Full Excel Studio UI |
| `GET` | `/_sutram/excel/tables` | List of all registered tables |
| `GET` | `/_sutram/excel/data/:table` | Lazy-loaded table data with filter, sort, search |
| `GET` | `/_sutram/excel/filter-values/:table/:col` | Live distinct values and counts for column filters |
| `POST` | `/api/_sutram/schema/create-table` | Create dynamic table at runtime |
| `POST` | `/api/_sutram/schema/seed-demo` | Seeds demo ERP tables (`item`, `contact`, `stock_ledger`) |
| `GET` | `/_sutram/menu` | Auto-generated navigation menu from metadata |
| `ALL` | `/api/:table/*` | Dynamic CRUD for any table |

---

## 5. Dynamic Table Creation Example

You can create tables dynamically via the UI "+ New Table" modal or via cURL:

```bash
curl -X POST http://localhost:3300/api/_sutram/schema/create-table \
  -H "Content-Type: application/json" \
  -d '{
    "table_name": "vehicle_fleet",
    "label": "Vehicle Fleet (वाहन विवरण)",
    "columns": [
      { "column_name": "vehicle_no", "col_type": "string", "label": "Vehicle No", "is_required": 1 },
      { "column_name": "driver_name", "col_type": "string", "label": "Driver Name" },
      { "column_name": "capacity_tons", "col_type": "number", "label": "Capacity (Tons)" },
      { "column_name": "is_active", "col_type": "boolean", "label": "Active", "default_value": "1" }
    ]
  }'
```
The table is immediately created in SQLite with an `_id` primary key, registered in `sys_table`, `sys_column`, auto-registered in `sutramExcel`, and becomes editable in Excel Studio without restarting the server!
