# Quiz Bank Validation

The protected files `quiz/quiz_all_modules_en.json` and `quiz/quiz_all_modules_en.csv` contain the same structurally valid 15-question English bank. They are duplicate representations and are imported at most once per source hash.

Run `npm run quiz:validate` to repeat the structural, duplicate, format-equivalence, source-hash, module-title, and assessment-shape checks. The owner approved one course-wide English final with a 75% threshold and these canonical module titles:

1. Logistics Fundamentals
2. Trucks & Equipment
3. Carrier Sourcing
4. Booking and Rate Negotiation
5. Documents
6. Dispatch and Track and Trace
7. Accessorials
8. Delivery and Load Closing

`quiz/import-manifest.json` records that approval and pins the protected JSON hash. Migration `202610040011` provides a service-role-only, source-hash-idempotent importer. The owner approved unlimited attempts with no cooldown. The importer creates a published final version with `enabled=false`: required module knowledge checks remain separate and module content is incomplete. Answer keys are written only to `private.quiz_answer_keys`; no answer-bearing source may be copied into `public/`, frontend source, logs, or generated reports.
