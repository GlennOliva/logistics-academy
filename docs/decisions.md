# Decision Register

Statuses: **Direct fact** is explicit in one or more of the six reviewed local references. **Provisional** is a Day 1 choice made across conflicting or incomplete sources. **Blocked** means the affected launch behavior must not be finalized or published without owner/content/legal input. The prior owner specification and Drive inventory are identified separately and are not treated as direct file evidence.

| Topic | Evidence | Day 1 decision | Owner | Status / correction gate |
| --- | --- | --- | --- | --- |
| Proof submission | Direct conflict: SOP and generic `website-policies.md` say website upload; completed `Policies.docx` says email | Keep private website upload primary; use email for support only | Project owner | Provisional; no code correction now, but policy wording must be reconciled |
| Account timing | Direct conflict: SOP registers before payment; FAQ says account/dashboard/Learning Path after verification | Register before checkout; unlock learning only after approval | Project owner | Provisional; FAQ must be clarified. Email verification is an added Day 1 security step |
| Access duration | SOP says lifetime; both policy versions retain `[lifetime access / 12 months]` | Keep no enrollment expiry and qualify public lifetime copy pending terms | Project owner/legal reviewer | Provisional; publication blocked until placeholder is resolved |
| Module count | FAQ says eight; prior Drive inventory reports four folders only | Represent eight planned slots; do not invent or publish missing content; keep sales disabled | Content owner/trainer | Blocked before sale of a “complete” eight-module offer |
| Module grouping | FAQ lists nine topics for eight modules without grouping; prior inventory names only Modules 1-4 | Keep Modules 5-8 untitled | Content owner/trainer | Blocked pending authoritative module titles and topic grouping |
| Final quiz retakes | `Policies.docx` literally says `7 / after a waiting period` | Do not configure seven attempts or a cooldown from malformed text | Content owner/trainer | Blocked for production final quiz |
| Pass score | `Policies.docx` says 75%; generic template still has `[pass mark, e.g., 70%]` | Use 75% in the draft implementation | Project owner/legal reviewer | Direct completed value; final publication still requires policy approval |
| Refund values | `Policies.docx`: 3 days; less than 20%; no download/final quiz/certificate; less processing fees; 7-14 business days; duplicate/no-access remedy | Display only as a draft summary; preserve manual review; do not promise automatic eligibility | Project owner/legal reviewer | Direct completed values in an unfinished template; blocked for publication |
| Payment review timing | SOP: up to 24 hours; `Policies.docx`: `24 hours / 1 business day`; generic template repeats the unresolved alternative | Use “may take up to 24 hours” from SOP | Project owner | Provisional; policy alternative must be removed before publication |
| Jurisdiction/location | `Policies.docx` fills Davao City court/contact fields; generic template leaves city blank; Contact DOCX has no city; prior owner specification also says Davao City | Keep Davao City in draft copy | Project owner/legal reviewer | Directly present but not legally certified; review required |
| Contact email | `Contact US_.docx`: `Anjval27@gmail.com`; `Policies.docx`: `anjval27@gmail.com` in refund/contact, but privacy email remains blank; generic template leaves all email fields blank | Use the same address operationally; normalize display casing and complete approved policy fields later | Project owner/legal reviewer | Direct fact with incomplete template fields; publication blocked |
| Price | FAQ says `₱699` | Store PHP 699.00 as `69900` centavos | Project owner | Direct fact; implemented correctly |
| Payment methods | Original sources list GCash, Maya, and bank transfer; owner subsequently supplied and approved GCash and MariBank QR assets | Offer only GCash and MariBank for new payments; retain the disabled Maya row and existing method IDs for history | Project owner | Owner-approved configuration; implemented in the isolated test project |
| Payment access control | SOP says proof must not automatically grant access and admin verifies actual payment | Preserve manual verification and enrollment gate | Project owner | Direct fact; implemented correctly in Day 1 foundations |
| Module completion | About says Knowledge Checks after lessons; FAQ says every module includes Knowledge Checks; no source supplies a check pass threshold | Require completion/check participation only after exact assessment rules are supplied | Content owner/trainer | Provisional; implementation blocked on course/quiz content |
| Payment upload limits | No reviewed source defines file types or size | Keep engineering default JPG/PNG/PDF, maximum 10 MB, with server-side validation | Technical owner/project owner | Provisional engineering rule; disclose/approve before launch |
| Branding | No logo/headshot/favicon/thumbnail is present locally; availability exists only in prior Drive inventory | Keep temporary text/neutral branding and do not call it client-approved | Project owner | Blocked for final brand signoff |
| Payment destinations | Owner supplied one branded GCash QR and one branded MariBank/InstaPay QR; decoded recipient labels match the visible assets | Publish only the verified masked GCash recipient and MariBank recipient label; require in-app recipient confirmation rather than inventing a full account number | Project owner | Implemented and positively verified in the isolated test project |
| Policies | `Policies.docx` is partially filled but retains unresolved brackets; `website-policies.md` is expressly a generic, non-legal-advice template | Keep visible development-draft warnings; publish neither source verbatim | Project owner/legal reviewer | Blocked for publication; current gate is correct |
| Email delivery | Sources require account/payment communications, but no provider/SMTP configuration is supplied | Use no production delivery claim until configured and tested | Project owner | Blocked for delivery test/launch |
| Initial admin | SOP requires an administrator but no admin identity is supplied | Provision only through a trusted audited process after the auth user exists | Project owner | Blocked for UAT/launch |

## Direct Facts Established

- Academy/operator: Logistics VA Training Academy, operated by Angela Valiente.
- Logistics 101 costs PHP 699 and is beginner-focused, self-paced, and offered in English and Bisaya.
- Angela's supplied biography states eight years in major U.S. logistics companies across carrier sales, logistics coordination, customer success, account management, and logistics quality analysis.
- New manual payments use GCash or MariBank. The original Maya record remains disabled for historical compatibility. Access is never granted merely because proof was submitted.
- Contact details are `Anjval27@gmail.com`, `+639633442176`, and `https://www.facebook.com/angela.arana.33/`.
- Davao City appears in the completed jurisdiction and contact fields of `Policies.docx`; it is not present in the Contact DOCX, and the generic Markdown template still has a city placeholder.
- The course does not guarantee employment or income. No accreditation, company names, student counts, ratings, testimonials, placement results, or earnings claims are supplied.

## Day 1 Corrections Assessment

- No immediate source-code correction is required for the provisional website-upload, register-first, lifetime/no-expiry, 75%, or up-to-24-hours choices; each is supported by at least one direct source and is currently disclosed or launch-gated.
- Day 1 is intentionally incomplete against the SOP: course PDFs/downloads, learning progress, assessments, certificates, transactional approval/rejection/refund/resubmission, broader admin management, reports, exports, and email remain to be built. These are implementation follow-ups, not documentation corrections.
- Before launch, normalize email presentation, replace every policy placeholder/alternative, settle proof channel and account timing language, approve access duration and refund wording, define the retake/cooldown rule, and supply the authoritative eight-module grouping.
- Keep course sales disabled until the sellable course assets and remaining launch gates are complete; GCash and MariBank may remain configured for test verification.

## Owner Inputs Still Required

Approved proof-submission channel; account-creation wording; lifetime versus 12-month access; all English/Bisaya lesson assets and module knowledge checks; legally reviewed policies and effective dates; normalized contact fields; email provider/sender; host/domain; production access; owner UAT and launch authorization.
