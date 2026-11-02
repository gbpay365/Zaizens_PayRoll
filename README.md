# ZAIZENS PAY

Payroll, HR and compliance application for Caminco S.A. Runs independently of Account_Core and HMS.

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

The application shell uses the ZAIZENS identity: a light navigation rail with grouped links and an ink top bar carrying the company chip, over warm paper surfaces with amber accents. Base layout styles live in `public/css/sage.css` and the identity layer in `public/css/zaizens.css`; the shell itself is `views/partials/sage-sidebar.ejs` plus `hms-module-odoo-start.ejs`.

## HR module

`/hr` is the HR home: today's absences, upcoming approved leave, the approval queue, personal leave balances, the latest payslip and upcoming holidays, all on the same shared records as payroll and tax.

| Screen | Route | Who |
|--------|-------|-----|
| HR overview | `/hr` | everyone |
| Request time off | `/hr/request-leave` | everyone |
| My leave balance | `/hr/my-leave-balance` | everyone |
| My attendance | `/hr/my-attendance` | everyone |
| My payslips | `/hr/my-payslips` | everyone |
| Leave approvals | `/hr/leave-requests` | HR / admin |
| Leave balances | `/hr/leave-balances` | HR / admin |
| Public holidays | `/hr/holidays` | HR / admin |
| Attendance register | `/hr/attendance` | HR / payroll write |

Employees can be deleted one at a time or in bulk from the Employees register; deleting an employee also removes their login account, pay profile, payroll lines, leave records and attendance. Super Admin accounts and your own account are protected, and every deletion is written to the admin audit trail.

Leave balances show entitlement, days taken (approved), days pending and the remaining balance. Employee records in `/payroll/employees/:id` show the same leave/attendance data next to the salary breakdown, and payslips, payroll runs and tax declarations all read the same payroll tables. Non-admin users land on `/hr` after sign-in and are redirected there if they open a payroll-only page.

## Admin module

`/admin` is the administration home for accounts, roles and security. It is visible in the sidebar to System Admin (role 1), Super Admin (role 99) and any role holding `access_control.manage`; everyone else gets a 403.

| Screen | Route | Purpose |
|--------|-------|---------|
| Overview | `/admin` | Headcount, active/inactive accounts, role and permission totals, recent admin activity |
| Accounts | `/admin/accounts` | Search/filter accounts, see role, status, last reset and whether a password change is due |
| New account | `/admin/accounts/new` | Create a login, choose a role, set a password and optionally force a change at first sign-in |
| Edit account | `/admin/accounts/:id` | Rename, change role, activate/deactivate, reset password, toggle the must-change flag |
| Roles | `/admin/roles` | List roles with user and permission counts |
| Role editor | `/admin/roles/:role` | Rename a role and tick its permissions, grouped by module, with a filter box |
| Security | `/admin/security` | Password policy, sign-in lockout and organisation-wide forced password change |
| Activity | `/admin/activity` | Read-only audit trail of account, role and security changes |
| Integrations | `/payroll/integrations` | Create facilities (tenants), store their URLs and API keys, and switch integrations, API access and HMS employee sync on or off per facility |
| My password | `/account/password` | Self-service password change, also used when a change is forced |

Security rules enforced by the module:

- Password policy (minimum length, digits, uppercase) is stored in `tbl_admin_security` and applied when creating or resetting any password.
- Too many failed sign-ins for the same username and IP block further attempts for the configured lockout window.
- Accounts with `password_must_change = 1` are forced to `/account/password` at sign-in and on every other request until they set a new password.
- System Admin and Super Admin always have full access and cannot be edited or deleted. A Super Admin can only be created or modified by another Super Admin.
- No one can deactivate their own account or change their own role, and a non-super admin cannot remove `access_control.manage` from their own role.
- Roles that still have users cannot be deleted.

The module creates its own tables on boot (`lib/ensureAdminSchema.js`): `tbl_admin_audit`, `tbl_admin_security`, the base `tbl_acl_permission` / `tbl_acl_role_permission` tables when they are missing, and the `password_must_change` / `last_reset_at` columns on `tbl_employee`. It also seeds the payroll/HR permission catalogue and grants it to roles 1 and 99.

Account_Core no longer controls payroll in HMS.
