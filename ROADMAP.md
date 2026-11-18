# 🗺️ Sutram Eco-System — Master Feature Roadmap & Upgrade Blueprint

> **Core Strategy**: **Single-User Desktop Perfection FIRST**, then **Multi-User LAN & Mobile Expansion**.
> Every feature in this roadmap strictly follows the **Universal Zero-Domain-Hardcoding Principle** — capable of replacing and surpassing complex bespoke ERPs (like HisabKitab, hospital systems, inventory, accounting, logistics) purely through live database introspection (`sys_table`, `sys_column`, `sys_relation`, `sys_report`).

---

## 🎯 Phase 1: Single-User ERP Perfection (Complex Data & UI Capabilities)
*Goal: Make Sutram UI capable of handling every complex real-world ERP workflow (HMP/Batches, Many-to-Many, Master-Detail Vouchers, Cascading Lookups, Ledger Balances) effortlessly.*

### 1.1 Many-to-Many (M:N) Relationships & Multi-Select FK Columns
- **Problem Solved**: Standard 1:N foreign keys cannot model relationships like *Item $\leftrightarrow$ Multiple Categories*, *Student $\leftrightarrow$ Multiple Courses*, or *Batch $\leftrightarrow$ Multiple Tags*.
- **Universal Solution**:
  - Support a native `multi_fk` / `junction` relation type in `sys_column` & `sys_relation`.
  - Automatically detect and manage standard SQLite **junction tables** (e.g. `item_categories(item_id, category_id)`) as well as JSON-array FK columns.
  - Render searchable **PrimeNG `p-multiSelect` tag chips** directly inside grid cells, filters, and entry forms.

### 1.2 Master-Detail Split Grid & Hierarchical Sub-Rows (HMP / Batch / Voucher Pattern)
- **Problem Solved**: Complex workflows like HMP Batches, Purchase Orders, Invoices, or Proposals require a **Parent Header** (Date, Party, Status, Total) linked to **Multiple Child Line-Items** (and optional 3rd-level allocations/distributions).
- **Universal Solution**:
  - **Expandable Row Sub-Grids & Docked Split Pane**: Clicking any parent row reveals its linked child table rows immediately underneath or in a side/bottom split workbench.
  - **Auto Roll-Up Aggregations**: Live `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` formulas on child tables automatically update parent summary columns (e.g. `order.total_amount = SUM(order_items.line_total)`).
  - **Batch Split / Allocation Wizard**: Distribute quantity/amount from a single master entry across multiple child targets with live "Remaining Unallocated Balance" indicator.

### 1.3 Cascading Dependent Dropdowns & Tree Hierarchies
- **Problem Solved**: Selecting a parent entity (e.g., *State* $\rightarrow$ *City* $\rightarrow$ *Branch*, or *Item* $\rightarrow$ *Sub-Item* $\rightarrow$ *Variant*) must dynamically filter child choices and display visual hierarchy (`↳`).
- **Universal Solution**:
  - Add `depends_on` column metadata in `sys_column` (auto-detected from FK chains!).
  - Selecting a value in Column A automatically filters the `p-dropdown` options in Column B, clears stale mismatched values, and supports self-referencing parent-child trees (`parent_id`).

### 1.4 Dynamic Entry Form Mode (Spreadsheet $\leftrightarrow$ Form View Toggle)
- **Problem Solved**: Spreadsheet grids are ideal for bulk editing, while structured forms are faster and safer for complex multi-field / Master-Detail vouchers.
- **Universal Solution**:
  - One-click toggle between **Excel Grid View** and **Auto-Generated Structured Form View** (Header section + Child line-items table + live computed fields + keyboard-first `Enter`/`Tab` navigation + `Ctrl+S` save).

### 1.5 Period Locking & Row Freeze Rules (Closing / Finalization)
- **Problem Solved**: Once a month, financial year, or batch is closed/verified, accidental edits must be blocked.
- **Universal Solution**:
  - Universal table rule: lock rows matching a condition (e.g., `entry_date <= '2026-03-31'` or `status = 'CLOSED'`) as strictly read-only with a lock indicator, unlockable only by Admin with password/PIN confirmation.

### 1.6 Universal File & Document Attachment Column (`type: 'file' | 'image'`)
- **Problem Solved**: Storing scanned bills, vehicle documents (RC/Insurance/PUC), prescriptions, or IDs linked to specific rows.
- **Universal Solution**:
  - Store attachments cleanly outside code in `SutramData/attachments/<project_slug>/`.
  - Inline preview modal (image zoom + PDF viewer) and direct integration with **Smart Watchdog Reminders** for expiry tracking.

---

## 📊 Phase 2: Universal Reports, Ledgers, Print & Analytics
*Goal: Close the reporting gap so users can generate any summary, ledger, pivot, Excel report, or printable PDF without writing SQL.*

### 2.1 Universal Visual Report & Query Builder (`sutramReports` / `sys_report`)
- **Multi-Table Visual JOIN Builder**: Pick primary table + auto-suggested FK-joined tables and descriptor columns.
- **Dynamic Multi-Filter Bar**: Combine Date Range pickers, Multi-Select FK dropdowns, Numeric min/max ranges, and Text search; save favorite filter combinations as **Named Report Presets**.
- **Grouping, Subtotals & Grand Totals**: Group by any 1-3 columns (e.g., Month $\rightarrow$ Category $\rightarrow$ Party) with collapsible summary rows and footer totals.

### 2.2 Universal Running Ledger & Opening/Closing Stock Engine
- **Problem Solved**: Accounting ledgers and Inventory (Inward / Outward / Stock Balance / Closing) are needed across almost every ERP.
- **Universal Solution**:
  - Configure any **Ledger Definition** in `sys_report`:
    - **IN Source** (e.g., Purchases / Receipts / Credits)
    - **OUT Source** (e.g., Sales / Issues / Debits)
    - **Group Key** (e.g., Item, Account, Party, Store) + **Date Column**
  - Automatically computes **Opening Balance + Total IN − Total OUT = Closing Balance** for any date range, plus a **Running Balance Statement View** (4-box summary cards + chronological row-by-row ledger).

### 2.3 Pivot Table (Cross-Tab) View
- Drag-and-drop **Rows $\times$ Columns $\times$ Values (`SUM`/`COUNT`/`AVG`)** directly over any table or saved report (e.g., Items $\times$ Months, Branches $\times$ Categories).

### 2.4 Universal Styled Excel & Print / PDF Template Designer (`sutramPrint`)
- **Styled Excel Export**: Export any report, grouped summary, or ledger with formatted headers, totals, auto-fit column widths, and print-ready page setup.
- **Print & PDF Designer**: Visual template builder using `{{column_name}}` placeholders and child-row loops for A4 invoices, vouchers, receipts, and 80mm thermal slips — with 1-click Print or Save as PDF.

### 2.5 No-Code Live KPI Dashboard (`sutramAnalytics`)
- Per-project customizable Home Dashboard with KPI cards (Total Records, Sums, Alerts/Watchdog Counts) and interactive charts (Bar, Line, Pie/Donut) powered 100% by `sys_table` and `sys_report`.

---

## 🛡️ Phase 3: Single-User Desktop Reliability & Daily Safety
*Goal: Bulletproof daily desktop experience for non-technical end users.*

### 3.1 Automated Scheduled Database Backups + 1-Click USB / Cloud Sync
- Automatic daily / on-app-close compressed ZIP backup of `SutramData/projects/*.db` into `SutramData/db_backups/` (configurable retention: last 15–30 backups).
- One-click **"Export Backup to Pendrive / Google Drive Folder"** and 1-click **"Restore Database"** with safety verification.

### 3.2 Row-Level Audit Trail & Time-Travel Undo (`sys_audit_log`)
- Record every insert/update/delete (`table`, `row_id`, `column`, `old_value`, `new_value`, `user`, `timestamp`).
- Built-in History Drawer per row with 1-click **"Restore Previous Value"**.

### 3.3 Tauri v2 System Tray & Native OS Reminder Notifications
- Minimize to Windows Taskbar / macOS Menu Bar tray so Sutram's Smart Watchdog Reminders keep monitoring in the background.
- Trigger native Windows/macOS desktop toast alerts when a reminder rule fires (even when the window is minimized).

### 3.4 Codebase Hygiene & Performance Optimization
- Unify `ng-sutramui-excel` and `ng-sutramui-vision` to a single source of truth (eliminate duplicate copies between `packages/` and `sutramUI/src/`).
- Split large SCSS files (`sutram-excel-studio.component.scss` currently `108 kB`) cleanly under Angular's 100 kB budget.
- Add SQLite `VACUUM` / `PRAGMA integrity_check` utility inside Project Settings for long-term database health.

---

## 🌐 Phase 4: Multi-User LAN Collaboration & Mobile Companion
*Goal: Expand seamlessly once Single-User Perfection is complete.*

### 4.1 In-App Remote LAN Project Tabs
- Open discovered LAN peer projects **directly inside your Tauri app's top tab bar** (marked with a `🌐 Remote: <PC-Name>` badge), transparently routing that tab's requests via `ProjectHttpInterceptor` to `http://<peer_ip>:3300` with `x-lan-token`.

### 4.2 Real-Time Live Multi-User Sync (WebSockets over `sutramLan`)
- Broadcast row/cell mutations instantly across all connected LAN peers (Google Sheets style live updates).
- Show live presence indicators (e.g., *"👤 Editing Row 14"*) and optimistic conflict prevention.

### 4.3 QR Code Mobile Companion (PWA before Native App)
- Show a scannable **QR Code** in the LAN panel — scanning from any phone on the same Wi-Fi opens a fast **Mobile-Responsive PWA View** for quick stock checks, form entries, and **Mobile Camera $\rightarrow$ Vision OCR** directly into the PC's database.

### 4.4 Dedicated Native Mobile App (Future — Flutter / Capacitor)
- Local UDP LAN auto-discovery (`sutramLan` protocol) + offline-first sync cache + barcode/QR scanner + receipt OCR camera.

---

## 🧭 Recommended Execution Order

| Priority | Milestone | Why First? |
| :---: | :--- | :--- |
| **1** | **Phase 1.1 & 1.3**: Many-to-Many + Cascading Dependent Dropdowns | Unlocks real-world relational schemas immediately |
| **2** | **Phase 1.2 & 1.4**: Master-Detail Split Grid (HMP/Voucher) + Form View | Unlocks complex parent-child & batch workflows |
| **3** | **Phase 2.1 & 2.2**: Universal Report Builder + Running Ledger / Closing | Closes the #1 gap for daily business clients |
| **4** | **Phase 2.4 & 3.1**: Print/PDF Templates + Auto DB Backup Scheduler | Makes single-user desktop deployment production-ready |
| **5** | **Phase 3.2 & 3.3**: Audit Trail + Tauri System Tray / Native Alerts | Enterprise reliability & polish |
| **6** | **Phase 4.1 – 4.3**: In-App LAN Tabs, Real-Time WebSocket Sync & Mobile QR | Multi-user & mobile scale-up |
