# Launch Checklist

Last updated: 2026-10-04

This checklist separates implemented test readiness from commercial launch approval. Production deployment is not authorized.

| Gate | Status | Required evidence / next action |
| --- | --- | --- |
| Linked environment | PASS | Isolated project `dvwwnqoujtctlfvwcrgf` positively matched; migrations `001`–`013` match |
| Development admin | PASS | Confirmed active Auth identity, database admin role, bootstrap audit, guarded browser password login, backend authorization, and `/admin` routing verified |
| Test student registration | PASS | Owner-approved test-only auto-confirm; browser signup, profile/policy trigger, sign-out, password login, `/dashboard`, and zero student roles verified |
| Production email verification | BLOCKED | Must be enabled with verified SMTP/domain/sender and tested mailbox before any production launch |
| Eight module titles | PASS | Owner-approved normalized catalog stored as eight required draft modules |
| Lesson content | BLOCKED | Approved English/Bisaya lesson files are still absent; keep modules draft |
| Module knowledge checks | BLOCKED | Required knowledge checks remain separate and have not been supplied; the final does not replace them |
| Final assessment source | PASS | One hosted source-hash-pinned version; 15 questions/private keys, one audit, 75% threshold, and repeat import returns `created=false` |
| Final assessment security | PASS | Browser role cannot access private keys; hosted rollback-only scoring proves 12/15 passes and 11/15 fails server-side |
| Final retry policy | PASS | Owner approved unlimited attempts and no cooldown |
| Final availability | BLOCKED | Hosted final remains disabled until lesson content and all required module knowledge checks are complete |
| GCash | PASS, TEST PROJECT | Branded QR, masked verified recipient, instructions, public delivery, private proof submission, and pending review verified |
| MariBank | PASS, TEST PROJECT | Branded InstaPay QR, verified recipient label, instructions, public delivery, private proof submission, and approval path verified |
| Maya | DISABLED | Preserved only for historical compatibility; unavailable for new checkout and resubmission |
| Payment verification | PASS, TEST PROJECT | Pending, replacement request, immutable resubmission, rejection without access, and approval-only enrollment verified; no real funds transferred |
| Resend domain | INPUT REQUIRED | Exact verified domain with DNS status |
| Email sender | INPUT REQUIRED | Approved Auth sender name/address and worker `EMAIL_FROM` value |
| Email test mailbox | INPUT REQUIRED | Accessible disposable mailbox for confirmation, recovery, and worker delivery |
| Application origin | INPUT REQUIRED | Exact deployed HTTPS origin for Auth URLs, `APP_ORIGINS`, and `PUBLIC_APP_ORIGIN` |
| Email secrets | SECURE LOCAL CONFIG ONLY | Separate Resend SMTP/worker keys and worker bearer secret; never provide in chat or `VITE_*` values |
| Password recovery | UNAVAILABLE | UI disables recovery while `VITE_EMAIL_DELIVERY_ENABLED=false`; do not claim a message was sent |
| Real email delivery | NOT RUN | Owner deferred provider setup; verify Auth confirmation/recovery plus worker database, provider, mailbox, and idempotency evidence when supplied |
| Email worker schedule | APPROVED, NOT CONFIGURED | Run every five minutes only after positive real-delivery and idempotency checks pass |
| Sales | BLOCKED | Keep disabled until lesson content, module knowledge checks, production email, policy review, and owner launch authorization pass |
| Production | PROHIBITED | No production project/domain/deployment has been authorized |
