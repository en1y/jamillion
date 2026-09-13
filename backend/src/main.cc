#include <drogon/drogon.h>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include "admin.h"
#include "auth.h"
#include "catalog.h"
#include "ratelimit.h"
#include "quiz.h"

using namespace drogon;

static std::string env(const char *k, const char *def = "")
{
    const char *v = std::getenv(k);
    return v ? v : def;
}

// ponytail: same as python-dotenv's load_dotenv(): nearest .env up from cwd, exported vars win.
// KEY=value lines only, no quotes or expansion; IDE run configs don't refresh env, this does.
static std::filesystem::path loadDotenv()
{
    for (auto dir = std::filesystem::current_path(); ; dir = dir.parent_path()) {
        if (std::ifstream in(dir / ".env"); in) {
            for (std::string line; std::getline(in, line);) {
                const auto eq = line.find('=');
                if (line.empty() || line[0] == '#' || eq == std::string::npos) continue;
                setenv(line.substr(0, eq).c_str(), line.substr(eq + 1).c_str(), 0);
            }
            return dir;
        }
        if (dir == dir.parent_path()) return std::filesystem::current_path();
    }
}

int main()
{
    // Trantor's logger fwrites to stdout and only flushes at error level, so in a
    // container -- where stdout is a pipe, not a tty -- INFO and WARN sit in the
    // buffer until the process exits. The startup line is what you look for after
    // `docker compose up`, so make stdout line buffered instead.
    setvbuf(stdout, nullptr, _IOLBF, 0);
    const auto root = loadDotenv();
    try { auth::configure(); }
    catch (const std::exception &e) { LOG_ERROR << e.what(); return 1; }
    auth::registerRoutes();
    quiz::configure(root);
    quiz::registerRoutes();
    admin::registerRoutes();
    catalog::registerRoutes();
    limits::configure();
    // ponytail: no config.json, everything comes from .env / environment
    const auto port = static_cast<uint16_t>(std::stoi(env("PORT", "8080")));

    // The query timeout rides the client, and it has to be passed here: the
    // manager behind getDbClient() only exists once the framework is running, so
    // a getDbClient()->setTimeout() from main() dereferences null. Without it --
    // Drogon's own default is no timeout -- a query that finds no ready
    // connection is buffered and never called back, so a database that is down
    // hangs every route instead of failing it. 0 spells "no timeout".
    const auto dbTimeout = std::stod(env("DB_TIMEOUT_SEC", "5"));
    app().createDbClient("postgresql", env("PGHOST", "localhost"),
                         static_cast<unsigned short>(std::stoi(env("PGPORT", "5432"))),
                         env("PGDATABASE", "jamillion"), env("PGUSER", "jamillion"),
                         env("PGPASSWORD", "jamillion"), 2, "", "default", false, "",
                         dbTimeout);

    app().registerHandler("/api/health", [](const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&cb) {
        app().getDbClient()->execSqlAsync(
            "SELECT count(*) FROM rarity_tiers",
            [cb](const orm::Result &r) {
                Json::Value j;
                j["ok"] = true;
                j["tiers"] = r[0][0].as<int>();
                cb(HttpResponse::newHttpJsonResponse(j));
            },
            [cb](const orm::DrogonDbException &e) {
                // Public route: log the database's own words, report only that
                // it is down. Every other route already makes this trade.
                LOG_ERROR << e.base().what();
                Json::Value j;
                j["ok"] = false;
                auto resp = HttpResponse::newHttpJsonResponse(j);
                resp->setStatusCode(k500InternalServerError);
                cb(resp);
            });
    });

    LOG_INFO << "jamillion listening on :" << port;
    // The largest legitimate body is POST /api/quizzes: seven questions and
    // their expanded answer key, a few tens of kB. TLS and the static files are
    // Caddy's job, so this process only ever sees JSON.
    const auto maxBody = static_cast<size_t>(std::stoul(env("MAX_BODY_BYTES", "262144")));
    app().setClientMaxBodySize(maxBody)
         .setClientMaxMemoryBodySize(maxBody)
         .addListener("0.0.0.0", port).setThreadNum(4).run();
}
