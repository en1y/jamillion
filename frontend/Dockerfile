# The SPA and the reverse proxy are one image: Caddy serves dist/ and forwards
# /api to the backend, so the browser only ever sees a single origin.
FROM node:24-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite.config.ts sets envDir: '..', and the root .env is not in the build
# context. Vite also reads VITE_-prefixed process env, so these arrive that way.
# They are baked into the bundle: this image is specific to one Supabase project.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
# Vite has nothing to fall back on: an unset arg is inlined as `undefined` and
# every sign-in fails in the browser, hours after the build said it was fine.
RUN test -n "$VITE_SUPABASE_URL" && test -n "$VITE_SUPABASE_ANON_KEY"
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
