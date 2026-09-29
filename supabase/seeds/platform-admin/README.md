# Platform super admin seed — dev@flowza.ai

`01_super_admin.sql` creates (or refreshes) the super-admin login of the **admin portal** at
`https://time.flowza.ai/adm` — auth user → `user_profiles` → `platform_admins` (level `owner`), plus a
`platform_admin.seeded` audit entry. Idempotent.

| Email | Temporary password | Level |
|---|---|---|
| dev@flowza.ai | `ChangeMe@FlowZa2026` | owner |

```sh
psql "$DATABASE_URL_ADMIN" -v ON_ERROR_STOP=1 -f supabase/seeds/platform-admin/01_super_admin.sql
```

or paste the file into the Supabase SQL editor.

- **Re-running resets the password** to the temporary one. On a project where the account already exists with a real
  password, running this replaces it; use `pnpm --filter @flowza/database run seed:platform-admin` (docs/go-live.md §6),
  which reads the password from the environment, to rotate it instead.
- The account is flagged `password_is_temporary`; the portal shows a banner until the password is changed under
  **My account → Change password**, which clears the flag.
- Platform administrators must sign in with MFA (the API refuses them below `aal2`). The first sign-in at `/adm/login`
  asks for authenticator enrolment; an account that already has a verified factor is asked for its code.
- Further administrators are added in the portal (**Admin team → Add administrator**, owners only); they need a FlowZa
  Time account first.
