#include "setup.h"
#include "auth.h"
#include <drogon/drogon.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
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
bool startSeeder(const Json::Value &settings, int artists) {
    const auto venv = rootDir / ".venv/bin/python";
    const std::string python = std::filesystem::exists(venv) ? venv.string() : "python3";
    const auto limit = std::to_string(artists);
    const auto log = (configDir / "seed.log").string();

    std::vector<std::string> env;
    for (char **entry = environ; *entry; ++entry) env.emplace_back(*entry);
    for (const auto &key : kKeys) env.push_back(std::string(key.seeder) + "=" + value(settings, key));
    env.emplace_back("SPOTIPY_CACHE_PATH=" + (configDir / ".spotipy-cache").string());
    std::vector<char *> envp;
    for (auto &entry : env) envp.push_back(entry.data());
    envp.push_back(nullptr);

    std::vector<std::string> args{python, "-u", "scripts/seed_music.py", "--limit", limit};
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
    LOG_INFO << "seeding " << artists << " artists (pid " << pid << "), log in " << log;
    return true;
}

Task<HttpResponsePtr> status(HttpRequestPtr) {
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
}

}  // namespace setup
