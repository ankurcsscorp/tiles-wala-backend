# Manage Users and module permissions

Implemented 27 October 2026. Open **Business management → Manage Users** (`/users`) as an Admin.

## Using the page

- **Users:** search by name/mobile, open a user, set the account user type and active status, and select Inherit / Allow / Deny for module View and Manage permissions. Reset to user type defaults removes individual overrides. Save explicitly applies the changes.
- **User type defaults:** select Salesperson, Tile Mistire, or Plumber Mistiri and save the default module permissions for all accounts of that type. Existing individual overrides remain in place.
- **Manage** requires **View**. The form enables View when granting Manage and denies both when View is denied. The server also prevents effective Manage permission when View is denied.
- Admin accounts always retain full access. Their permissions cannot be reduced with overrides. A signed-in Admin cannot disable or demote their own account. Other Admin accounts can be changed by an active Admin.

The page manages existing accounts. Existing signup and Admin signup-key rules remain. It does not expose or edit password hashes. Store membership and store roles continue to be managed through Stores.

## Permission model

`services/permissions.js` and the identical frontend utility define the catalog and role defaults. Effective access is built from application role defaults, saved user-type settings, then user overrides. Account type still controls existing commission business behavior; module grants do not impersonate Admin.

Modules include sales, purchases/receiving, payments, returns, inventory/adjustments, transfers, customers, suppliers, financial reports, dashboard, product management, invoice settings, enquiries, collection management, and own bonus records. Reports/dashboard/own bonus are read-only permission groups. Public gallery reads and public enquiry creation remain public. User management, store administration/assignments, payment-method administration, and commission administration remain Admin-only.

Non-admin grants do not bypass active store assignments, inventory/manager roles, return approvals, tax eligibility, document lifecycle rules, or finalized-record protections. Catalog lookup reads needed by authorized operational modules remain available without granting catalog editing. Customer/supplier searches are available to authorized sales/purchase readers; creating parties requires their own module Manage permission. Payment methods can be read by authenticated users. Receiving money during sales finalization or through the sales payment endpoint also requires Payments Manage; recording supplier payments requires Payments Manage as well as purchase access when using the purchase endpoint.

Sidebar and route access follow effective View permissions. Delegated product/collection editing uses Manage permission. View-only module pages display a clear banner; backend endpoints reject mutations without Manage, including direct API requests. Some existing module action buttons remain visible to view-only users; authorization remains authoritative at the API.

## Storage and migration

Migration `025_user_permissions.sql` adds:

- `users.is_active`, default TRUE.
- `users.permission_overrides`, default empty JSONB object.
- `role_permission_settings` keyed by non-admin user type, with JSONB settings, updating Admin, and timestamp.

No existing identities, passwords, store assignments, or financial data are rewritten. The migration was applied to the configured local database. Other environments must run `npm run migrate` before deploying this backend. The paired down migration refuses rollback while restrictions/defaults are configured so access controls cannot disappear silently.

Changes to user access and role defaults are serialized under one transaction advisory lock. The actor is rechecked as an active Admin inside the transaction. Changes and before/after audit records in `audit_logs` commit together. No secrets are included in managed-user responses or audit payloads.

## Authentication and refresh

Login rejects disabled accounts. Every authenticated API request loads current account status, type, role settings, and individual overrides from PostgreSQL. Existing JWTs therefore cannot retain revoked access or continue working after disabling an account. The frontend refreshes `/users/me` on sign-in/session restore, window focus, and every 30 seconds. A 401 clears its stored session. Role changes do not require issuing a new token; UI refresh follows the session refresh while server enforcement applies to the next request.

## API

All paths below `/api/tiles/users`:

| Method | Path | Access |
| --- | --- | --- |
| GET | `/me` | Active authenticated user; current effective permissions |
| GET | `/` | Admin; paged users (`q`, `offset`, page size 25) |
| GET | `/permissions` | Admin; module catalog and effective user-type defaults |
| PUT | `/roles/:userType` | Admin; `{permissions: {"sales.view": true, ...}}` |
| PUT | `/:id/access` | Admin; `{userType, isActive, permissionOverrides}` |
| GET | `/search` | Existing Admin-only bonus user search, retained |

Unknown permission keys/non-boolean flags are rejected. Inactive sessions receive 401; unauthorized module actions receive 403 with `PERMISSION_DENIED`. Self-demotion/deactivation returns 409. Clear an override by omitting its key from the saved override object.

## Verification

Backend coverage includes default inheritance, individual denials, View/Manage dependency, shared browser/server definitions, actual HTTP routes, immediate changes with an existing token, denied direct writes, denied user-management escalation, disabled login/sessions, self-lockout protection, invalid keys, and audit records. Database fixtures roll back. Existing billing/inventory/party/printing tests remain part of regression verification.

Primary implementation files: `controllers/users.js`, `middleware/auth.js`, `middleware/permissions.js`, `services/permissions.js`, module routes, authentication/sales/invoice-settings controllers, frontend `components/users/UserManagement.jsx`, `App.js`, authentication context, navigation/business shell, and delegated product/collection/sales controls.

Final verification: all 121 backend tests passed with PostgreSQL access and no skips; all 186 frontend tests passed across 32 suites; production build compiled successfully. Tests use rolled-back database fixtures. No existing account roles, active statuses, or explicit grants were changed during implementation; migration 025 supplies preserving defaults.
