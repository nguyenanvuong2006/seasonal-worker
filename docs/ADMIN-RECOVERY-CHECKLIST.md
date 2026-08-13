# Admin recovery checklist

- [ ] Run `migrations/2026-08-14-reactivate-admin-anvuong.sql` on production Neon.
- [ ] Verify `anvuong | ADMIN | true`.
- [ ] Sign in again.
- [ ] Review Audit Log for the accidental deactivation event.
- [ ] Do not use the inline status badge again until the User Management UI follow-up is deployed.
