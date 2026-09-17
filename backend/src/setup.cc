#include "setup.h"
#include "auth.h"
#include <drogon/drogon.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern char **environ;

using namespace drogon;
namespace setup {
namespace {

std::filesystem::path rootDir, configDir;
std::mutex lock;                      // settings.json and the seeder, one request at a time
std::atomic<pid_t> seeder{0};         // the running seed_music.py, 0 when none

// The four things a deployment used to put in .env: the settings.json field,
// the .env name development still uses, and the variable the seeder reads.
struct Key { const char *field, *dotenv, *seeder; };
constexpr Key kKeys[] = {
    {"lastfm_api_key", "LASTFM_API_KEY", "LASTFM_API_KEY"},
    {"youtube_api_key", "YOUTUBE_API_KEY", "YOUTUBE_API_KEY"},
    {"spotify_client_id", "SPOTIFY_CLIENT_ID", "SPOTIPY_CLIENT_ID"},
    {"spotify_client_secret", "SPOTIFY_CLIENT_SECRET", "SPOTIPY_CLIENT_SECRET"},
};

Json::Value load() {
    Json::Value settings(Json::objectValue);
    std::ifstream in(configDir / "settings.json");
    if (in) {
        Json::CharReaderBuilder reader;
        std::string ignored;
        Json::parseFromStream(reader, in, &settings, &ignored);
    }
    return settings;
}

// The saved value, or the environment's: development keeps its keys in .env,
// and a key set there counts as configured without the setup page.
std::string value(const Json::Value &settings, const Key &key) {
    const auto saved = settings[key.field].asString();
    if (!saved.empty()) return saved;
    const char *fromEnv = std::getenv(key.dotenv);
    return fromEnv ? fromEnv : "";
}

// Written beside itself and renamed over, so a crash never leaves half a file,
// and 0600 before a byte of it exists.
bool save(const Json::Value &settings) {
    std::error_code ignored;
    std::filesystem::create_directories(configDir, ignored);
    const auto path = configDir / "settings.json", next = configDir / "settings.json.next";
    const int fd = open(next.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) return false;
    Json::StreamWriterBuilder writer;
    const auto text = Json::writeString(writer, settings);
    const bool ok = write(fd, text.data(), text.size()) == static_cast<ssize_t>(text.size());
    close(fd);
    return ok && rename(next.c_str(), path.c_str()) == 0;
}

// seed_music.py in the background, logging to CONFIG_DIR/seed.log. Its
// environment is built before fork(), because between fork and exec a
// multithreaded process may only make async-signal-safe calls.
bool startSeeder(const Json::Value &settings, int artists, const std::vector<std::string> &named = {}) {
    const auto venv = rootDir / ".venv/bin/python";
    const std::string python = std::filesystem::exists(venv) ? venv.string() : "python3";
    const auto limit = std::to_string(artists);
    const auto log = (configDir / "seed.log").string();
    const auto progress = (configDir / "seed-progress.json").string();
    std::error_code ignored;
    // The log and the progress file are the only trace a run leaves. Without the
    // directory the child's open() fails and the run goes dark: no log, and the
    // progress file the dashboard polls never appears.
    std::filesystem::create_directories(configDir, ignored);
    std::filesystem::remove(progress, ignored);

    std::vector<std::string> env;
    for (char **entry = environ; *entry; ++entry) env.emplace_back(*entry);
    for (const auto &key : kKeys) env.push_back(std::string(key.seeder) + "=" + value(settings, key));
    env.emplace_back("SPOTIPY_CACHE_PATH=" + (configDir / ".spotipy-cache").string());
    std::vector<char *> envp;
    for (auto &entry : env) envp.push_back(entry.data());
    envp.push_back(nullptr);

    std::vector<std::string> args{python, "-u", "scripts/seed_music.py", "--progress-file", progress};
    if (named.empty()) {
        args.emplace_back("--limit");
        args.push_back(limit);
    } else {
        args.emplace_back("--artists");
        args.insert(args.end(), named.begin(), named.end());
    }
    if (value(settings, kKeys[2]).empty()) args.emplace_back("--no-spotify");
    std::vector<char *> argv;
    for (auto &arg : args) argv.push_back(arg.data());
    argv.push_back(nullptr);
    const auto dir = rootDir.string();

    const pid_t pid = fork();
    if (pid < 0) return false;
    if (pid == 0) {
        setsid();
        const int fd = open(log.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); close(fd); }
        if (chdir(dir.c_str()) != 0) _exit(126);
        execvpe(argv[0], argv.data(), envp.data());
        _exit(127);
    }
    seeder = pid;
    // Reaped here, so a finished seeder is not left a zombie that still looks alive.
    std::thread([pid] { waitpid(pid, nullptr, 0); seeder = 0; }).detach();
    LOG_INFO << "seeding " << (named.empty() ? limit + " chart artists"
                                             : std::to_string(named.size()) + " named artists")
             << " (pid " << pid << "), log in " << log;
    return true;
}

Task<HttpResponsePtr> status(HttpRequestPtr req) {
    const auto settings = load();
    try {
        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "SELECT (SELECT count(*) FROM profiles WHERE role = 'admin') AS admins, "
            "       (SELECT count(*) FROM artists) AS artists");
        Json::Value out;
        out["admin"] = rows[0]["admins"].as<long>() > 0;
        out["configured"] = !value(settings, kKeys[0]).empty();
        out["seeding"] = seeder.load() != 0;
        out["artists"] = static_cast<Json::Int64>(rows[0]["artists"].as<long>());
        out["seed_target"] = settings["seed_target"].asInt();
        if (req->path().rfind("/api/seeder", 0) == 0) {   // the staff view: also the run state
            // What the catalog actually holds, and what it is missing. An artist row
            // with no tracks is a half-seeded artist: it exists, and the editor can
            // find nothing to ask about, so it belongs beside the outright failures.
            const auto counts = co_await app().getDbClient()->execSqlCoro(
                "SELECT (SELECT count(*) FROM albums) AS albums, "
                "       (SELECT count(*) FROM tracks) AS tracks, "
                "       (SELECT count(*) FROM tracks WHERE preview_url IS NOT NULL) AS previews, "
                "       (SELECT max(updated_at) FROM artists) AS last_seeded");
            Json::Value catalog;
            catalog["albums"] = static_cast<Json::Int64>(counts[0]["albums"].as<long>());
            catalog["tracks"] = static_cast<Json::Int64>(counts[0]["tracks"].as<long>());
            catalog["previews"] = static_cast<Json::Int64>(counts[0]["previews"].as<long>());
            catalog["last_seeded"] = counts[0]["last_seeded"].isNull() ? ""
                                                                      : counts[0]["last_seeded"].as<std::string>();
            out["catalog"] = catalog;

            // Named, not counted: an artist whose row exists with nothing under it is
            // retried by name like any failure, so the dashboard needs the names.
            const auto empty = co_await app().getDbClient()->execSqlCoro(
                "SELECT ar.name FROM artists ar WHERE NOT EXISTS "
                "  (SELECT 1 FROM tracks t JOIN albums al ON al.id = t.album_id WHERE al.artist_id = ar.id) "
                "ORDER BY ar.global_rank NULLS LAST, ar.name LIMIT 200");
            out["empty_artists"] = Json::Value(Json::arrayValue);
            for (const auto &row : empty) out["empty_artists"].append(row["name"].as<std::string>());

            const auto failures = co_await app().getDbClient()->execSqlCoro(
                "SELECT name, reason, attempts, last_try FROM catalog_failures "
                "ORDER BY attempts DESC, last_try DESC LIMIT 500");
            out["failures"] = Json::Value(Json::arrayValue);
            for (const auto &row : failures) {
                Json::Value one;
                one["name"] = row["name"].as<std::string>();
                one["reason"] = row["reason"].as<std::string>();
                one["attempts"] = row["attempts"].as<int>();
                one["last_try"] = row["last_try"].as<std::string>();
                out["failures"].append(one);
            }

            Json::Value progress;
            std::ifstream progressFile(configDir / "seed-progress.json");
            if (progressFile) {
                Json::CharReaderBuilder reader;
                std::string ignored;
                if (Json::parseFromStream(reader, progressFile, &progress, &ignored) && progress.isObject()) {
                    // A killed child leaves its last snapshot behind. Never call it running
                    // once the process has gone, even if the file says it was.
                    if (!out["seeding"].asBool() && progress["state"].asString() != "finished")
                        progress["state"] = "interrupted";
                    out["progress"] = progress;
                }
            }
        }
        auto response = HttpResponse::newHttpJsonResponse(out);
        response->addHeader("Cache-Control", "no-store");
        co_return response;
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Setup is not answering");
    }
}

// POST /api/setup, admin only: save whichever keys are given and, if `artists`
// is above zero, start seeding that many. Callable again later to add artists
// or replace a key; an empty or missing field leaves the saved value alone.
Task<HttpResponsePtr> apply(HttpRequestPtr req) {
    const auto body = req->getJsonObject();
    if (!body || !body->isObject()) co_return auth::error(k400BadRequest, "JSON body required");
    auto settings = load();
    for (const auto &key : kKeys) {
        if (!body->isMember(key.field)) continue;
        const auto &given = (*body)[key.field];
        if (!given.isString() || given.asString().size() > 200)
            co_return auth::error(k400BadRequest, (std::string(key.field) + " must be a string of at most 200 characters").c_str());
        auto text = given.asString();
        while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
        while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.erase(text.begin());
        if (!text.empty()) settings[key.field] = text;
    }
    const auto &artists = (*body)["artists"];
    if (!artists.isNull() && (!artists.isIntegral() || artists.asInt() < 0 || artists.asInt() > 2000))
        co_return auth::error(k400BadRequest, "artists must be between 0 and 2000");
    const int count = artists.isNull() ? 0 : artists.asInt();
    if (value(settings, kKeys[0]).empty())
        co_return auth::error(k400BadRequest, "A Last.fm API key is required");
    {
        // One lock over the check, the write and the start, so two presses cannot
        // both find no seeder running.
        std::lock_guard guard(lock);
        if (count > 0 && seeder.load() != 0)
            co_return auth::error(k409Conflict, "The seeder is already running");
        if (count > 0) settings["seed_target"] = count;
        if (!save(settings)) {
            LOG_ERROR << "could not write " << (configDir / "settings.json").string();
            co_return auth::error(k500InternalServerError, "Could not save the settings");
        }
        if (count > 0 && !startSeeder(settings, count))
            co_return auth::error(k500InternalServerError, "Could not start the seeder");
    }
    co_return co_await status(req);
}

// Staff can rerun the configured chart size or a list of named artists -- the ones
// that failed, typically, which is why a whole list goes in one run. These runs use
// the already stored keys and the same single-child lock as setup.
Task<HttpResponsePtr> rerun(HttpRequestPtr req) {
    const auto body = req->getJsonObject();
    if (!body || !body->isObject()) co_return auth::error(k400BadRequest, "JSON body required");
    const bool named = body->isMember("artists");
    if (named == body->isMember("limit"))
        co_return auth::error(k400BadRequest, "Provide either artists or limit");

    std::vector<std::string> artists;
    int count = 0;
    if (named) {
        const auto &given = (*body)["artists"];
        // One process per run, so a whole retry list goes in one argv rather than
        // one press per name. 200 is well inside any argv limit and hours of work.
        if (!given.isArray() || given.empty() || given.size() > 200)
            co_return auth::error(k400BadRequest, "artists must be a list of 1 to 200 names");
        for (const auto &entry : given) {
            if (!entry.isString()) co_return auth::error(k400BadRequest, "artists must be names");
            auto name = entry.asString();
            while (!name.empty() && std::isspace(static_cast<unsigned char>(name.back()))) name.pop_back();
            while (!name.empty() && std::isspace(static_cast<unsigned char>(name.front()))) name.erase(name.begin());
            if (name.empty() || name.size() > 120 || name.front() == '-' ||
                std::any_of(name.begin(), name.end(), [](unsigned char c) { return c < 32 || c == 127; }))
                co_return auth::error(k400BadRequest,
                                      "Each artist must be 1-120 characters, without control characters or a leading dash");
            artists.push_back(name);
        }
    } else {
        const auto &given = (*body)["limit"];
        if (!given.isIntegral() || given.asInt() < 1 || given.asInt() > 2000)
            co_return auth::error(k400BadRequest, "limit must be between 1 and 2000");
        count = given.asInt();
    }

    const auto settings = load();
    if (value(settings, kKeys[0]).empty())
        co_return auth::error(k409Conflict, "The catalog needs a Last.fm key before seeding");
    {
        std::lock_guard guard(lock);
        if (seeder.load() != 0)
            co_return auth::error(k409Conflict, "A catalog run is already in progress");
        if (!startSeeder(settings, count, artists))
            co_return auth::error(k500InternalServerError, "Could not start the seeder");
    }
    co_return co_await status(req);
}

// DELETE /api/seeder/failures, body { artists: [...] }: drop names the staff have
// given up on, so the list stays the work that is left. Seeding one again puts it
// back if it fails again.
Task<HttpResponsePtr> forget(HttpRequestPtr req) {
    const auto body = req->getJsonObject();
    if (!body || !(*body)["artists"].isArray() || (*body)["artists"].empty())
        co_return auth::error(k400BadRequest, "artists must be a list of names");
    std::vector<std::string> names;
    for (const auto &entry : (*body)["artists"])
        if (entry.isString()) names.push_back(entry.asString());
    try {
        for (const auto &name : names)
            co_await app().getDbClient()->execSqlCoro("DELETE FROM catalog_failures WHERE name = $1", name);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "The catalog is not answering");
    }
    co_return co_await status(req);
}

}  // namespace

void configure(const std::filesystem::path &root) {
    rootDir = root;
    const char *value = std::getenv("CONFIG_DIR");
    const std::filesystem::path dir(value && *value ? value : "./data/config");
    configDir = dir.is_absolute() ? dir : root / dir;
}

void registerRoutes() {
    app().registerHandler("/api/setup", &status, {Get});
    app().registerHandler("/api/setup", &apply, {Post, "auth::Optional", "auth::Admin"});
    // Setup remains readable before there is an account. Once the site is live,
    // the same non-secret catalog count is for the people writing its questions.
    app().registerHandler("/api/seeder", &status, {Get, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder", &rerun, {Post, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder/failures", &forget, {Delete, "auth::Optional", "auth::Moderator"});
}

}  // namespace setup
