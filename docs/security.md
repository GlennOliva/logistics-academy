# Security Notes

## Day 1 Controls

- Browser code receives only Supabase URL and publishable/anon key.
- Roles are read from `user_roles` through a security-definer checker, never editable user metadata.
- Financial state tables have read-only student policies; no student update/insert policy changes payment status.
- `create_order` snapshots the database course price and serializes duplicate open-order creation.
- Proof metadata linking is service-role-only. The Edge Function authenticates the user and checks file type, size, magic bytes, order ownership, enabled method and exact amount.
- Payment proofs are private. Only an admin can create a short-lived direct proof link under current Storage policies.
- Suspended users fail account-active checks in protected policies and trusted functions even with an existing JWT.
- Profile update privileges are column-limited so students cannot change account status or role.

## RLS Summary

Public users can read published course marketing records and eventually published policies. Active students can read their own profile, orders, payment records and enrollments. Admins can read operational records. Privileged transitions are intentionally absent until their audited trusted functions are implemented.

## Known Limits

- The schema and policies have not yet been run against a Supabase test project.
- A signed proof URL remains usable until its five-minute expiry after a role/access change.
- CORS limits browser origins but is not treated as authentication.
- Downloaded files cannot be withdrawn from a device.
- Rate limiting, transactional approvals, learning authorization, assessment scoring and certificate endpoints are later milestones.
