#include "setup.h"
#include "auth.h"
#include <drogon/drogon.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <deque>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <sstream>
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

// One catalog run, as the setup page or the dashboard asks for it. Either a list
// of names (always full depth) or a ranked list: Last.fm's chart or every artist
// Wikidata links to Deezer, the top `full` of them at full depth, the rest skinny.
struct Run {
    std::string source = "lastfm";
    int limit = 0, full = 1000, promote = 0;    // promote: that many skinny artists to full depth, nothing else
    bool youtube = true;
    std::vector<std::string> named;
};
constexpr int kMaxArtists = 50000;      // Wikidata knows ~35 000 Deezer artists; room to grow

std::string trimmed(std::string text) {
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.front()))) text.erase(text.begin());
    return text;
}

// The run fields of a request body, `limit` optional when `required` is false
// (the setup page may save keys without starting anything). Returns the
// complaint, or "" when the body is fine.
std::string parseRun(const Json::Value &body, Run &run, bool required) {
    if (body.isMember("artists") && body["artists"].isArray()) {
        const auto &given = body["artists"];
        // One process per run, so a whole retry list goes in one argv rather than
        // one press per name. 200 is well inside any argv limit and hours of work.
        if (given.empty() || given.size() > 200) return "artists must be a list of 1 to 200 names";
        for (const auto &entry : given) {
            if (!entry.isString()) return "artists must be names";
            const auto name = trimmed(entry.asString());
            if (name.empty() || name.size() > 120 || name.front() == '-' ||
                std::any_of(name.begin(), name.end(), [](unsigned char c) { return c < 32 || c == 127; }))
                return "Each artist must be 1-120 characters, without control characters or a leading dash";
            run.named.push_back(name);
        }
        return "";
    }
    const auto &limit = body["limit"];
    if (limit.isNull() && !required) return "";
    if (!limit.isIntegral() || limit.asInt() < (required ? 1 : 0) || limit.asInt() > kMaxArtists)
        return "limit must be between 1 and " + std::to_string(kMaxArtists);
    run.limit = limit.asInt();
    if (body.isMember("source")) {
        run.source = body["source"].asString();
        if (run.source != "lastfm" && run.source != "wikidata") return "source must be lastfm or wikidata";
    }
    if (body.isMember("full")) {
        if (!body["full"].isIntegral() || body["full"].asInt() < 0 || body["full"].asInt() > kMaxArtists)
            return "full must be between 0 and " + std::to_string(kMaxArtists);
        run.full = body["full"].asInt();
    }
    if (body.isMember("youtube")) run.youtube = body["youtube"].asBool();
    return "";
}

// seed_music.py in the background, logging to CONFIG_DIR/seed.log. Its
// environment is built before fork(), because between fork and exec a
// multithreaded process may only make async-signal-safe calls.
bool startSeeder(const Json::Value &settings, const Run &run) {
    const auto venv = rootDir / ".venv/bin/python";
    const std::string python = std::filesystem::exists(venv) ? venv.string() : "python3";
    const auto limit = std::to_string(run.limit);
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
    if (run.promote > 0) {
        args.insert(args.end(), {"--promote", std::to_string(run.promote)});
    } else if (run.named.empty()) {
        args.insert(args.end(), {"--source", run.source, "--limit", limit, "--full", std::to_string(run.full)});
    } else {
        args.emplace_back("--artists");
        args.insert(args.end(), run.named.begin(), run.named.end());
    }
    if (value(settings, kKeys[2]).empty()) args.emplace_back("--no-spotify");
    if (!run.youtube) args.emplace_back("--no-youtube");
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
    LOG_INFO << "seeding " << (run.promote > 0   ? "up to " + std::to_string(run.promote) + " skinny artists to full depth"
                               : run.named.empty() ? limit + " " + run.source + " artists, " + std::to_string(run.full) + " full"
                                                   : std::to_string(run.named.size()) + " named artists")
             << " (pid " << pid << "), log in " << log;
    return true;
}

// The last `want` lines of a log: the seeder's, under the dashboard's progress bar,
// or the updater's. The seeder never prints a key (its error lines name the
// exception type, not the URL), so the tail is safe for staff.
Json::Value logTail(size_t want, const std::filesystem::path &file = configDir / "seed.log") {
    std::deque<std::string> lines;
    std::ifstream in(file);
    for (std::string line; std::getline(in, line);) {
        lines.push_back(line);
        if (lines.size() > want) lines.pop_front();
    }
    Json::Value out(Json::arrayValue);
    for (const auto &line : lines) out.append(line);
    return out;
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
        out["seed_source"] = settings.get("seed_source", "lastfm").asString();
        out["seed_full"] = settings.get("seed_full", 1000).asInt();
        if (req->path().rfind("/api/seeder", 0) == 0) {   // the staff view: also the run state
            // What the catalog actually holds, and what it is missing. An artist row
            // with no tracks is a half-seeded artist: it exists, and the editor can
            // find nothing to ask about, so it belongs beside the outright failures.
            const auto counts = co_await app().getDbClient()->execSqlCoro(
                "SELECT (SELECT count(*) FROM albums) AS albums, "
                "       (SELECT count(*) FROM tracks) AS tracks, "
                "       (SELECT count(*) FROM tracks WHERE preview_url IS NOT NULL) AS previews, "
                "       (SELECT count(*) FROM tracks WHERE ytmusic_plays IS NOT NULL) AS plays, "
                "       (SELECT count(*) FROM artists WHERE depth = 'full') AS full, "
                "       (SELECT count(*) FROM artists WHERE depth = 'skinny') AS skinny, "
                "       (SELECT count(*) FROM artist_aliases) AS aliases, "
                "       (SELECT max(updated_at) FROM artists) AS last_seeded");
            Json::Value catalog;
            for (const char *field : {"albums", "tracks", "previews", "plays", "full", "skinny", "aliases"})
                catalog[field] = static_cast<Json::Int64>(counts[0][field].as<long>());
            // A first Wikidata run reads 35 000 Deezer pages to rank them (~75 min); the
            // dashboard's estimate needs to know whether that is already behind us.
            catalog["wikidata_cached"] = std::filesystem::exists(rootDir / "data/deezer-fans.json");
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
    // `artists` is the field the first setup page has always sent; `limit` is the dashboard's
    Json::Value request = *body;
    if (request.isMember("artists") && request["artists"].isIntegral() && !request.isMember("limit"))
        { request["limit"] = request["artists"]; request.removeMember("artists"); }
    Run run;
    if (const auto complaint = parseRun(request, run, false); !complaint.empty())
        co_return auth::error(k400BadRequest, complaint.c_str());
    const int count = run.limit;
    if (value(settings, kKeys[0]).empty())
        co_return auth::error(k400BadRequest, "A Last.fm API key is required");
    {
        // One lock over the check, the write and the start, so two presses cannot
        // both find no seeder running.
        std::lock_guard guard(lock);
        if (count > 0 && seeder.load() != 0)
            co_return auth::error(k409Conflict, "The seeder is already running");
        if (count > 0) {
            settings["seed_target"] = count;
            settings["seed_source"] = run.source;
            settings["seed_full"] = run.full;
        }
        if (!save(settings)) {
            LOG_ERROR << "could not write " << (configDir / "settings.json").string();
            co_return auth::error(k500InternalServerError, "Could not save the settings");
        }
        if (count > 0 && !startSeeder(settings, run))
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
    if (body->isMember("artists") == body->isMember("limit"))
        co_return auth::error(k400BadRequest, "Provide either artists or limit");
    Run run;
    if (const auto complaint = parseRun(*body, run, true); !complaint.empty())
        co_return auth::error(k400BadRequest, complaint.c_str());

    auto settings = load();
    if (value(settings, kKeys[0]).empty())
        co_return auth::error(k409Conflict, "The catalog needs a Last.fm key before seeding");
    {
        std::lock_guard guard(lock);
        if (seeder.load() != 0)
            co_return auth::error(k409Conflict, "A catalog run is already in progress");
        if (run.named.empty()) {        // the dashboard's choice becomes the default the setup status reports
            settings["seed_target"] = run.limit;
            settings["seed_source"] = run.source;
            settings["seed_full"] = run.full;
            save(settings);
        }
        if (!startSeeder(settings, run))
            co_return auth::error(k500InternalServerError, "Could not start the seeder");
    }
    co_return co_await status(req);
}

// DELETE /api/seeder: stop the run. The seeder commits an artist at a time, so
// whatever landed stays, and the progress file reads "interrupted" from here on.
// setsid() in the child made it a process group of its own: the whole group goes.
Task<HttpResponsePtr> stop(HttpRequestPtr req) {
    const pid_t pid = seeder.load();
    if (pid != 0) {
        kill(-pid, SIGTERM);
        LOG_INFO << "stopping the seeder (pid " << pid << ")";
        // the reaper thread flips `seeder` once the child is gone; give it a moment
        for (int i = 0; i < 20 && seeder.load() != 0; ++i) co_await drogon::sleepCoro(app().getLoop(), 0.1);
    }
    co_return co_await status(req);
}

// GET /api/seeder/log: the tail of the seeder's log, for the dashboard.
Task<HttpResponsePtr> logLines(HttpRequestPtr req) {
    size_t want = 80;
    if (const auto given = req->getParameter("lines"); !given.empty())
        want = std::clamp<size_t>(std::strtoul(given.c_str(), nullptr, 10), 1, 1000);
    Json::Value out;
    out["lines"] = logTail(want);
    out["seeding"] = seeder.load() != 0;
    auto response = HttpResponse::newHttpJsonResponse(out);
    response->addHeader("Cache-Control", "no-store");
    co_return response;
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

// Every hour, when nothing else is seeding, the biggest skinny artists get the
// full pipeline, so a catalog seeded wide fills in deep by itself over the weeks.
// PROMOTE_BATCH artists per hour (default 20, ~15 min of work; 0 turns it off).
// ponytail: a fixed hourly timer, not a scheduler; the batch size is the only knob.
void promoteSkinny() {
    const int batch = std::atoi(std::getenv("PROMOTE_BATCH") ? std::getenv("PROMOTE_BATCH") : "20");
    if (batch <= 0 || seeder.load() != 0) return;
    const auto settings = load();
    if (value(settings, kKeys[0]).empty()) return;      // not set up yet
    app().getDbClient()->execSqlAsync(
        "SELECT count(*) AS skinny FROM artists WHERE depth = 'skinny'",
        [batch, settings](const orm::Result &rows) {
            if (rows[0]["skinny"].as<long>() == 0) return;
            Run run;
            run.promote = batch;
            std::lock_guard guard(lock);
            if (seeder.load() == 0 && !startSeeder(settings, run)) LOG_ERROR << "could not start the hourly promotion";
        },
        [](const orm::DrogonDbException &e) { LOG_ERROR << "promotion skipped: " << e.base().what(); });
}

// --- updates: the notice and the Update button in ground control ---------------
//
// The backend never touches Docker. It learns the newest release from Docker Hub
// once an hour and, when an admin presses Update, drops a flag in UPDATE_DIR. The
// opt-in `updater` service in compose.yaml watches that folder, runs the update and
// writes status.json and update.log back; `alive` is its heartbeat.

std::filesystem::path updateDir;
std::mutex releaseLock;
std::string latestRelease;              // "" until Docker Hub has answered once

// "1.0.10" -> {1, 0, 10}; "latest", "1.1.0-rc1" and the like -> {} and never newest.
std::vector<int> semver(const std::string &tag) {
    int major, minor, patch;
    char rest;
    if (std::sscanf(tag.c_str(), "%d.%d.%d%c", &major, &minor, &patch, &rest) != 3) return {};
    return {major, minor, patch};
}

// RELEASES_URL answers either Docker Hub's tag list ({results: [{name}]}) or a
// plain registry's (/v2/<name>/tags/list, {tags: [...]}); the second is what a
// local registry speaks, for trying an update without Docker Hub. Empty turns the
// check off. ponytail: the first page is enough, Docker Hub lists newest first.
void checkRelease() {
    const char *given = std::getenv("RELEASES_URL");
    const std::string url = given ? given
        : "https://hub.docker.com/v2/namespaces/en1y/repositories/jamillion/tags?page_size=100";
    const auto slash = url.find('/', url.find("://") == std::string::npos ? 0 : url.find("://") + 3);
    if (url.empty() || slash == std::string::npos) return;
    auto client = HttpClient::newHttpClient(url.substr(0, slash));
    auto req = HttpRequest::newHttpRequest();
    const auto target = url.substr(slash);
    const auto question = target.find('?');
    req->setPath(target.substr(0, question));
    if (question != std::string::npos) {
        std::istringstream pairs(target.substr(question + 1));
        for (std::string pair; std::getline(pairs, pair, '&');)
            if (const auto eq = pair.find('='); eq != std::string::npos) req->setParameter(pair.substr(0, eq), pair.substr(eq + 1));
    }
    // The client is captured so it outlives the request it is sending.
    client->sendRequest(req, [client, url](ReqResult result, const HttpResponsePtr &response) {
        const auto body = result == ReqResult::Ok && response->statusCode() == k200OK ? response->getJsonObject() : nullptr;
        if (!body || !body->isObject()) {     // a 404 too, until the first release is published
            LOG_WARN << "release check: no tag list from " << url << " ("
                     << (result == ReqResult::Ok ? std::to_string(response->statusCode()) : to_string(result)) << ")";
            return;
        }
        std::vector<std::string> tags;
        for (const auto &one : (*body)["results"]) tags.push_back(one["name"].asString());
        for (const auto &one : (*body)["tags"]) tags.push_back(one.asString());
        std::string newest;
        for (const auto &tag : tags)
            if (!semver(tag).empty() && (newest.empty() || semver(newest) < semver(tag))) newest = tag;
        std::lock_guard guard(releaseLock);
        if (!newest.empty()) latestRelease = newest;
    }, 10.0);
}

bool updaterAlive() {
    std::error_code missing;
    const auto beat = std::filesystem::last_write_time(updateDir / "alive", missing);
    return !missing && std::filesystem::file_time_type::clock::now() - beat < std::chrono::seconds(30);
}

// GET /api/update, admin only: this version, the newest release, and the updater.
Task<HttpResponsePtr> updateStatus(HttpRequestPtr) {
    Json::Value out;
    out["current"] = JAM_VERSION;
    {
        std::lock_guard guard(releaseLock);
        out["latest"] = latestRelease.empty() ? Json::Value() : Json::Value(latestRelease);
        out["available"] = !latestRelease.empty() && semver(JAM_VERSION) < semver(latestRelease);
    }
    out["updater"] = updaterAlive();
    out["requested"] = std::filesystem::exists(updateDir / "requested");
    std::ifstream file(updateDir / "status.json");
    Json::Value state;
    Json::CharReaderBuilder reader;
    std::string ignored;
    out["status"] = file && Json::parseFromStream(reader, file, &state, &ignored) ? state : Json::Value();
    out["log"] = logTail(40, updateDir / "update.log");
    auto response = HttpResponse::newHttpJsonResponse(out);
    response->addHeader("Cache-Control", "no-store");
    co_return response;
}

// POST /api/update, admin only: ask the updater to update. The flag is an empty
// file -- nothing in the request reaches the side that holds the Docker socket.
Task<HttpResponsePtr> requestUpdate(HttpRequestPtr req) {
    if (!updaterAlive())
        co_return auth::error(k409Conflict, "The updater is not running. Add COMPOSE_PROFILES=updater to .env and run "
                                            "docker compose up -d, or update by hand.");
    const auto flag = updateDir / "requested";
    const int fd = open(flag.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd < 0)
        co_return errno == EEXIST ? auth::error(k409Conflict, "An update is already under way")
                                  : auth::error(k500InternalServerError, "Could not ask the updater");
    close(fd);
    LOG_INFO << "update requested from ground control";
    co_return co_await updateStatus(req);
}

}  // namespace

void configure(const std::filesystem::path &root) {
    rootDir = root;
    const char *value = std::getenv("CONFIG_DIR");
    const std::filesystem::path dir(value && *value ? value : "./data/config");
    configDir = dir.is_absolute() ? dir : root / dir;
    const char *update = std::getenv("UPDATE_DIR");
    const std::filesystem::path flags(update && *update ? update : "./data/update");
    updateDir = flags.is_absolute() ? flags : root / flags;
}

void registerRoutes() {
    // The loop exists only once the framework runs, hence the beginning advice.
    app().registerBeginningAdvice([] {
        app().getLoop()->runEvery(3600.0, promoteSkinny);
        app().getLoop()->runAfter(5.0, checkRelease);
        app().getLoop()->runEvery(3600.0, checkRelease);
    });
    app().registerHandler("/api/update", &updateStatus, {Get, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/update", &requestUpdate, {Post, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/setup", &status, {Get});
    app().registerHandler("/api/setup", &apply, {Post, "auth::Optional", "auth::Admin"});
    // Setup remains readable before there is an account. Once the site is live,
    // the same non-secret catalog count is for the people writing its questions.
    app().registerHandler("/api/seeder", &status, {Get, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder", &rerun, {Post, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder", &stop, {Delete, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder/log", &logLines, {Get, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/seeder/failures", &forget, {Delete, "auth::Optional", "auth::Moderator"});
}

}  // namespace setup
