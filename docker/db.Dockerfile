# Supabase's Postgres image with everything the stack applies to it baked in, so
# a pulled deployment needs no checkout: the role passwords the image runs at
# initdb, and the migrations with their runner for the `migrate` one-shot.
# Keep the tag the Supabase CLI runs (CLAUDE.md).
FROM public.ecr.aws/supabase/postgres:17.6.1.165
COPY docker/roles.sql /etc/postgresql.schema.sql
COPY --chmod=755 docker/migrate.sh /usr/local/bin/jamillion-migrate
COPY supabase/migrations /jamillion/migrations
