# Zaizens Payroll

Standalone payroll & HR application extracted from HMS. Runs independently from Account_Core and HMS.

## Setup (XAMPP)

1. Copy `.env.example` to `.env` and set MySQL credentials.
2. `npm install`
3. `npm run db:create` — creates `zaizens_payroll` database in XAMPP MySQL
4. `npm start` — boots on http://127.0.0.1:3010
5. `npm run db:seed` — creates admin user `payadmin` / `admin123`

## Migrate data from HMS

Copy employees and payroll tables from the HMS MySQL database:

```powershell
cd C:\Zaizens_PayRoll
npm run migrate:from-hms -- --dry-run
npm run migrate:from-hms
```

Options:

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview row counts without writing |
| `--truncate` | Clear target payroll tables before copy |
| `--facility-id=1` | Copy rows for this facility only |
| `--employees=payroll` | Active staff + anyone with pay/leave records (default) |
| `--employees=active` | Active employees only |
| `--employees=all` | Every employee row |

Set `HMS_DB_*` in `.env` (or it reads `C:\HMS_JS\.env` as fallback).

Tables copied: `tbl_employee`, `tbl_role`, `tbl_facility`, all `tbl_hms_payroll_*`, leave/attendance, allowance settings, DIPE history, dept summaries.

## Features

All payroll features are enabled locally (profiles, monthly processing, payslips, tax hub, statutory reports, leave/attendance).

## Add an employee and generate the payslip

1. **Employees → New employee** (`/payroll/employees/new`), or the button on the dashboard / pay profiles page.
2. Fill in the identity, role, hire date and the **gross monthly salary**.
3. The preview panel shows the derived basic salary, housing (15%) and transport (10%), role allowances and every statutory deduction (CNPS, CFC, CRTV, council tax, FNE, IRPP, CAC), with the resulting net pay.
4. Saving creates the employee, their pay profile and a pending payroll line for the chosen period, then opens the employee page with the full breakdown and a link to the payslip.

The same calculation engine powers **Pay profiles →** the row calculator (enter a gross or net figure) and the monthly payroll run, so the numbers stay consistent.

## Interface

The application shell is a Sage-style layout: dark green navigation rail, a compact top bar and dense payroll tables. Styles live in `public/css/sage.css`; the shell itself is `views/partials/sage-sidebar.ejs` plus `hms-module-odoo-start.ejs`.

Account_Core no longer controls payroll in HMS.
