#!/bin/sh
# Applies supabase/migrations/ in order, each once and each in its own
# transaction, and records them in the table the Supabase CLI uses -- so
# `npx supabase migration list --db-url ...` reads this database like its own.
# Runs after GoTrue is healthy, because the migrations hang a trigger on auth.users.
set -eu
. /secrets/env
export PGHOST=db PGUSER=postgres PGDATABASE=postgres PGPASSWORD="$DB_PASSWORD"
# The migrations' own NOTICEs ("already exists, skipping") are not news on every boot.
export PGOPTIONS="-c client_min_messages=warning"
q() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

q -c 'CREATE SCHEMA IF NOT EXISTS supabase_migrations;
      CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations
        (version text PRIMARY KEY, statements text[], name text)'

applied=0
for file in /jamillion/migrations/*.sql; do
    base=$(basename "$file" .sql)
    version=${base%%_*}
    [ -n "$(q -tA -c "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '$version'")" ] && continue
    echo "migrate: applying $base"
    q -1 -f "$file" \
      -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '${base#*_}')"
    applied=$((applied + 1))
done
echo "migrate: $applied applied, schema at $version"
