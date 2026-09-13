# The SPA and the reverse proxy are one image: Caddy serves dist/ and forwards
# /api to the backend, so the browser only ever sees a single origin.
FROM node:24-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# No VITE_SUPABASE_* here: the anon key is generated when the stack first boots,
# after this image is built, so the browser reads it from /config.js at runtime
# and Supabase itself sits on the page's own origin. One image, any deployment.
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
