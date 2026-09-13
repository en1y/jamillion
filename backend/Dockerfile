# The Drogon and jwt-cpp clone-and-build takes minutes, so it gets its own layer:
# CMakeLists.txt alone is enough to configure, and only then does src/ arrive.
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential cmake git ca-certificates \
        libpq-dev libssl-dev zlib1g-dev libjsoncpp-dev uuid-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY backend/CMakeLists.txt ./
# The glob in CMakeLists.txt needs at least one source to configure at all, and
# configuring is what clones and builds the dependencies. CONFIGURE_DEPENDS
# re-globs once the real sources land, so the stub only has to exist, not build.
# jwt-cpp is header-only, so drogon is the whole of the expensive build.
RUN mkdir -p src && echo 'int main() { return 0; }' > src/_stub.cc \
    && cmake -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j "$(nproc)" --target drogon
COPY backend/src ./src
RUN rm -f src/_stub.cc && cmake --build build -j "$(nproc)"

# Not a static binary: ensureAudio() shells out to scripts/fetch_audio.py and the
# setup page starts scripts/seed_music.py, so the runtime carries python and the
# seed script's dependencies in a venv that is first on PATH. The same image runs
# the stack's first-boot `setup` one-shot (docker/setup.py).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq5 libssl3 zlib1g libjsoncpp26 libuuid1 ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app jamillion
COPY scripts/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY --from=build /src/build/jamillion /usr/local/bin/jamillion
COPY scripts/fetch_audio.py scripts/seed_music.py ./scripts/
COPY docker/setup.py ./docker/setup.py
# main.cc's loadDotenv() finds no .env here and falls back to the working
# directory, which is what AUDIO_DIR, CONFIG_DIR and scripts/ resolve against.
RUN mkdir -p /app/data/audio /app/data/config && chown -R jamillion:jamillion /app
USER jamillion
EXPOSE 8080
CMD ["jamillion"]
