#!/usr/bin/env bash
# Applies the academy migrations to a throwaway PostgreSQL cluster and proves the
# authorization, transactional, progress and scoring behavior that local Supabase
# (Docker) and the hosted project cannot prove from the command line alone.
#
# Scope: SQL, RLS, and transaction semantics only. Auth email delivery, the Storage
# API, and Edge Functions are explicitly NOT covered and stay NOT RUN until a hosted
# Supabase test project is available.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/bin}"
PGDATA="${PGDATA:-/tmp/logistics-academy-pgdata}"
PGPORT="${PGPORT:-54329}"
HARNESS_DB="academy_harness"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"

for binary in initdb pg_ctl psql; do
  if [ ! -x "${PG_BIN}/${binary}" ]; then
    echo "missing PostgreSQL binary: ${PG_BIN}/${binary}" >&2
    exit 1
  fi
done

cleanup() {
  if [ "${KEEP_CLUSTER}" = "0" ]; then
    "${PG_BIN}/pg_ctl" -D "${PGDATA}" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "${PGDATA}"
  else
    echo "cluster kept at ${PGDATA} on port ${PGPORT}"
  fi
}
trap cleanup EXIT

echo "==> starting throwaway PostgreSQL on port ${PGPORT}"
rm -rf "${PGDATA}"
"${PG_BIN}/initdb" -D "${PGDATA}" -U postgres -A trust >/dev/null
"${PG_BIN}/pg_ctl" -D "${PGDATA}" -o "-p ${PGPORT} -F" -w start >/dev/null

export PGHOST=127.0.0.1 PGPORT="${PGPORT}" PGUSER=postgres

"${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
SQL
"${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -c "create database ${HARNESS_DB}"

echo "==> applying Supabase-compatible bootstrap"
"${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -d "${HARNESS_DB}" -f "${ROOT}/supabase/testharness/bootstrap.sql"

echo "==> applying migrations"
for migration in "${ROOT}"/supabase/migrations/*.sql; do
  echo "    $(basename "${migration}")"
  "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -d "${HARNESS_DB}" -f "${migration}"
done

echo "==> applying seed"
"${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -d "${HARNESS_DB}" -f "${ROOT}/supabase/seed.sql"

echo "==> running assertions"
"${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -d "${HARNESS_DB}" -f "${ROOT}/supabase/testharness/assertions.sql" >/dev/null
node "${ROOT}/scripts/render-quiz-import-test-sql.mjs" |
  "${PG_BIN}/psql" -X -q -v ON_ERROR_STOP=1 -d "${HARNESS_DB}" >/dev/null

failures=$("${PG_BIN}/psql" -X -tA -d "${HARNESS_DB}" \
  -c "select count(*) from harness.results where passed is false")
total=$("${PG_BIN}/psql" -X -tA -d "${HARNESS_DB}" -c "select count(*) from harness.results")

"${PG_BIN}/psql" -X -d "${HARNESS_DB}" -c \
  "select passed, label from harness.results order by passed, label"

echo
echo "harness assertions: $((total - failures))/${total} passed"
if [ "${failures}" != "0" ]; then
  echo "FAILED assertions:" >&2
  "${PG_BIN}/psql" -X -tA -d "${HARNESS_DB}" \
    -c "select label from harness.results where passed is false" >&2
  exit 1
fi

echo
echo "NOT RUN on this harness: Auth email flows, Storage API uploads and signed"
echo "URLs, Edge Functions, and real payment review. Those require a hosted"
echo "Supabase test project."
