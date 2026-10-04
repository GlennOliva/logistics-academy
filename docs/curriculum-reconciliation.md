# Curriculum Reconciliation: 9 live modules vs the approved 8

Status: **proposal only. Nothing in this document has been applied.** Per instruction,
curriculum changes wait for confirmation of the exact mapping.

## 1. The nine live required modules

Course `logistics-101`, all `required = true`, all `curriculum_version = 1`.

| # | Module ID | Canonical title | Status | In enrollment snapshots | Progress rows | Has material |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `994538f1-1544-4df0-aaba-f968f7addf93` | Logistics Fundamentals | published | 5 of 5 | 1 | **Yes — EN + Bisaya PPTX (imported this session)** |
| 2 | `ca1f067e-b499-46c2-8471-256072d0071a` | Trucks & Equipment | published | 5 of 5 | 1 | No |
| 3 | `3d3f0426-7385-4cea-b43e-cb7f2b1d2002` | Carrier Sourcing | draft | 0 | 0 | No |
| 4 | `7196d8c5-0632-4427-841b-c8c2469e781b` | Booking and Rate Negotiation | draft | 0 | 0 | No |
| 5 | `7228d8b9-f80b-47b0-97c1-e3af7b8df2d4` | Documents | published | 5 of 5 | 1 | No |
| 6 | `0be31428-21bb-40b5-9110-0e9ebdb6c122` | Dispatch and Track and Trace | draft | 0 | 0 | No |
| 7 | `108173b3-9266-4b4a-b18b-bb6bb28a7275` | Accessorials | draft | 0 | 0 | No |
| 8 | `99ce1711-cb3b-4daa-a4a8-09e4b3c092ce` | Delivery and Load Closing | published | 5 of 5 | 1 | No |
| 9 | `06e34cfd-8861-49f0-b492-1091bba19dbe` | **NULL** | published | **5 of 5** | 1 | No |

Linked progress detail: exactly one real learner
(`g.oiva.523349@umindanao.edu.ph`) holds a `studied_at` on module 9
(2026-10-04 15:39:59 UTC). No `completed_at` and no knowledge-check completion
anywhere, so nothing has been certified against this curriculum.

## 2. Which module is the extra one, and on what evidence

Module 9 is the extra module. This is evidence-based, not a count argument:

1. **It is absent from the approved curriculum definition.** Migration
   `202610040011_approved_curriculum_and_final_import.sql` inserts exactly the eight
   approved positions 1-8 with `canonical_title`, and raises
   `'All eight approved modules must be represented'` when the final bank does not
   cover exactly eight module numbers.
2. **It is absent from the approved source manifest.** `quiz/import-manifest.json`
   lists positions 1-8 and no ninth. The approved 15-question bank maps to exactly
   8 module numbers (2 each for modules 1-7, 1 for module 8).
3. **It has no approved title.** Its `canonical_title` is `NULL` while positions 1-8
   all carry owner-approved titles.
4. **It was created after the approved eight.** Positions 1-8 were created
   `2026-10-03 17:28:49 UTC`; module 9 was created `2026-10-04 03:24:25 UTC`.
5. **It never had content.** Zero `module_translations`, no knowledge check, so it
   has never been a teachable unit.
6. **It disagrees with the certificate.** The supplied template and
   `course_certificate_configs.required_module_count` both say eight.

It is not, however, deletable as test residue: it is `required = true` in all five
enrollment snapshots and one real student has studied it. Whatever is decided, the
row and that study record should be preserved rather than cascaded away.

It also is not a scripted test artifact: `scripts/verify-hosted.mjs` creates its
throwaway modules at `position >= 100000`, and none of those remain.

## 3. Proposed eight-module mapping

Confirmed approved order, taken from migration 011 and the quiz manifest:

| Approved position | Title | Live module ID | Action |
| --- | --- | --- | --- |
| 1 | Logistics Fundamentals | `994538f1-1544-4df0-aaba-f968f7addf93` | Keep; material imported |
| 2 | Trucks & Equipment | `ca1f067e-b499-46c2-8471-256072d0071a` | Keep |
| 3 | Carrier Sourcing | `3d3f0426-7385-4cea-b43e-cb7f2b1d2002` | Keep |
| 4 | Booking and Rate Negotiation | `7196d8c5-0632-4427-841b-c8c2469e781b` | Keep |
| 5 | Documents | `7228d8b9-f80b-47b0-97c1-e3af7b8df2d4` | Keep |
| 6 | Dispatch and Track and Trace | `0be31428-21bb-40b5-9110-0e9ebdb6c122` | Keep |
| 7 | Accessorials | `108173b3-9266-4b4a-b18b-bb6bb28a7275` | Keep |
| 8 | Delivery and Load Closing | `99ce1711-cb3b-4daa-a4a8-09e4b3c092ce` | Keep |
| — | *retire from required curriculum, keep the row* | `06e34cfd-8861-49f0-b492-1091bba19dbe` | Set `required = false`, `status = 'draft'` |

Module 9 is demoted rather than deleted so the real student's `studied_at` and the
five snapshot rows stay intact and auditable.

## 4. Reconciling the existing 4- and 5-module snapshots

Why snapshots are short: `sync_enrollment_modules` inserts only modules whose
`status = 'published'` at enrollment time. Positions 1, 2, 5, 8 were published when
most enrollments were created, which is why those snapshots hold 4 or 5 modules
rather than 8. Modules 3, 4, 6 and 7 are still draft.

Target state for every active enrollment: 8 required modules, matching the approved
curriculum and the certificate.

Proposed reconciliation, in one forward migration, per active enrollment:

1. Insert the four missing approved modules (positions 3, 4, 6, 7) into
   `enrollment_modules` with `required = true`, `on conflict do nothing`. This
   preserves every existing row and adds only what the student was always owed.
2. Set `enrollment_modules.required = false` for module 9 only. The row stays, so
   the studied record survives and nothing cascades.
3. Leave all `module_progress`, `quiz_attempts`, and `certificates` rows untouched.
   `studied_at`, `completed_at` and `knowledge_check_completed_at` are never rewritten.
4. Re-check `enrollment_progress` per enrollment afterwards and confirm
   `required_total = 8` for all of them.

Two sequencing constraints:

- This should run **after** positions 3, 4, 6, 7 have genuine material and a reviewed
  knowledge check, otherwise students are given required modules they cannot finish.
- `start_quiz_attempt` and `ensure_certificate` both read the snapshot, so the final
  assessment and certificate remain locked until all eight are genuinely complete.
  No eligibility is bypassed and the generator guard is untouched.

## 5. What is still missing before the journey can complete

| Module | Material | Knowledge check |
| --- | --- | --- |
| 1 Logistics Fundamentals | **Supplied, imported (EN + Bisaya)** | Drafted, unpublished, awaiting trainer approval |
| 2 Trucks & Equipment | Missing | Missing |
| 3 Carrier Sourcing | Missing | Missing |
| 4 Booking and Rate Negotiation | Missing | Missing |
| 5 Documents | Missing | Missing |
| 6 Dispatch and Track and Trace | Missing | Missing |
| 7 Accessorials | Missing | Missing |
| 8 Delivery and Load Closing | Missing | Missing |

The course-wide final assessment stays exactly as approved: 15 questions,
pass threshold 75, unlimited attempts, no cooldown.
---

# 6. Applied state (2026-10-05)

The reconciliation below is no longer a proposal. Two migrations were applied to
the linked test project with `supabase db push`, and no reset was performed.

| Migration | Purpose |
| --- | --- |
| `202610050019_canonical_curriculum_reconciliation.sql` | Approved eight stay `published` + `required`; module 9 demoted to `draft` + not required; missing approved snapshot rows added to all seven enrollments; extra required flags removed; certificate-template-as-lesson translations unpublished |
| `202610050020_fix_certificate_eligibility_config_key.sql` | Fixes `certificate_eligibility`, which referenced `config.id` and failed at runtime with `42703` |

## Outcome

- Course config `required_module_count` is `8`.
- All seven enrollments now carry exactly the eight approved required snapshots.
- Module 9 remains present as an optional snapshot. Its `module_progress` history
  was preserved, not deleted.
- `ngek@gmail.com` is `8/8` required modules complete with a passing final score
  of `100`, and holds one active certificate.

## Material corrections

Module 1 version 2 and Modules 2–7 pointed `module_translations` at
certificate-template bytes. Those rows are now unpublished so no learner is served
template text as a lesson. Only the two genuine Module 1 PPTX uploads remain
published.

## Certificate blocker, resolved

The certificate was denied even though the learner was fully complete:

- `ensure_certificate` compares the enrollment's **required snapshot count**
  against the config's `required_module_count`.
- The enrollment required **9** modules (all nine were `published` + `required`
  at snapshot time) and the learner had completed `9/9`.
- The owner-approved config required **8**.

Completion gating read the snapshot set while certificate gating read the config,
so the two disagreed. Every other condition already passed: config enabled,
enrollment and account active, no outstanding required modules, final score
`100 >= 75`. The only unmet condition was the curriculum count.

Reconciling the curriculum to the approved eight resolved it. No guard was
loosened, no completion rule was bypassed, and the generator was not modified.
