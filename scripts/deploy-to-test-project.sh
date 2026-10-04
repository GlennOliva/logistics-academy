#!/usr/bin/env bash
# Applies the academy schema to the LINKED Supabase TEST project and deploys the
# Edge Functions there. Refuses to run without an explicit confirmation so this can
# never be pointed at production by accident.
#
# Secrets are never read from or written to the repository. The service-role key
# is set separately with `supabase secrets set` and is prompted for, not stored.
#
# Usage:
#   ./scripts/deploy-to-test-project.sh --project-ref <ref> [--yes]
set -euo pipefail

PROJECT_REF=""
ASSUME_YES=""
MIGRATIONS_DIR="supabase/migrations"
SEED_FILE="supabase/seed.sql"

while [ $# -gt 0 ]; do
  case "$1" in
    --project-ref) PROJECT_REF="$2"; shift 2 ;;
    --yes|-y) ASSUME_YES="yes"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "${PROJECT_REF}" ]; then
  echo "usage: $0 --project-ref <ref> [--yes]" >&2
  exit 2
fi

if ! printf '%s' "${PROJECT_REF}" | grep -Eq '^[a-z]{20}$'; then
  echo "a Supabase project ref is exactly 20 lowercase letters; got '${PROJECT_REF}'" >&2
  exit 2
fi

if [ ! -f "supabase/.temp/project-ref" ]; then
  echo "no linked Supabase project found; run an explicit test-project link first" >&2
  exit 2
fi
LINKED_REF="$(< supabase/.temp/project-ref)"
if [ "${LINKED_REF}" != "${PROJECT_REF}" ]; then
  echo "refusing: --project-ref does not match the linked project" >&2
  exit 2
fi

if [ -z "${ASSUME_YES}" ]; then
  cat <<EOF

About to modify the hosted Supabase project:

  ${PROJECT_REF}

Only continue if this is your isolated TEST project. Production is out of scope
for this repository. Type the project ref to confirm:
EOF
  read -r CONFIRM
  if [ "${CONFIRM}" != "${PROJECT_REF}" ]; then
    echo "aborted"
    exit 1
  fi
fi

echo "==> linked project details"
npx supabase projects list

echo
echo "==> pending migrations"
npx supabase migration list --linked

echo
echo "==> dry run"
npx supabase db push --linked --dry-run

if [ -z "${ASSUME_YES}" ]; then
  cat <<EOF

The dry run above shows exactly what will be applied. Re-run with --yes to apply.
EOF
  exit 0
fi

echo
echo "==> applying migrations"
npx supabase db push --linked

if [ -f "${SEED_FILE}" ]; then
  echo
  echo "==> applying seed (keeps course sales disabled)"
  npx supabase db push --linked --include-seed
fi

echo
echo "==> deployed functions"
for dir in supabase/functions/*/; do
  name="$(basename "${dir}")"
  echo "    ${name}"
  npx supabase functions deploy "${name}" --project-ref "${PROJECT_REF}"
done

cat <<EOF

Applied to ${PROJECT_REF}.

Remaining manual steps, all in the Supabase dashboard for that project:

  1. Authentication -> URL Configuration
       Site URL:               http://localhost:5173
       Redirect URLs:          http://localhost:5173/auth/callback
                               http://localhost:5173/reset-password
  2. Authentication -> Email: keep confirmation on for the first signup test.
  3. Set function secrets (prompted, never stored in the repo):
       npx supabase secrets set --project-ref ${PROJECT_REF}
  4. Create test identities, then grant admin through a trusted SQL session.
  5. Confirm the approved GCash and MariBank QR objects are present in branding/payment-qr.

Verify afterward:
  - Confirm sales_enabled=false and only GCash and MariBank are enabled.
  - Sign up in the browser, then confirm no enrollment exists yet.
EOF
