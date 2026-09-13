#include <drogon/drogon.h>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include "admin.h"
#include "auth.h"
#include "catalog.h"
#include "ratelimit.h"
#include "setup.h"
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

// The first thing to read after `docker compose up`: what is running, where to
// open it, what it is talking to, and what state that is in -- the database's
// answer included, so "is it wired up" is one log line rather than five probes.
// Runs once the loop is up, because the database client only exists then.
static void startupSummary(uint16_t port, double dbTimeout, size_t maxBody)
{
    app().getDbClient()->execSqlAsync(
        "SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations) AS migrations, "
        "       (SELECT max(version) FROM supabase_migrations.schema_migrations) AS schema, "
        "       (SELECT count(*) FROM profiles) AS accounts, "
        "       (SELECT count(*) FROM profiles WHERE role = 'admin') AS admins, "
        "       (SELECT count(*) FROM quizzes WHERE published) AS published, "
        "       (SELECT count(*) FROM artists) AS artists, "
        "       (SELECT count(*) FROM tracks) AS tracks, "
        "       EXISTS (SELECT 1 FROM quizzes WHERE quiz_date = game_today() AND published) AS today",
        [=](const orm::Result &r) {
            const auto &row = r[0];
            const auto url = env("PUBLIC_URL", "http://localhost:5173");
            const auto admins = row["admins"].as<long>();
            std::ostringstream out;
            out << "jamillion " JAM_VERSION " is up\n"
                << "\n    open         " << url << "\n";
            if (admins == 0)
                out << "    first run    nobody has set it up yet -- open " << url
                    << " to create the admin account and start the catalog\n";
            out << "\n    database     " << env("PGUSER") << "@" << env("PGHOST") << ":" << env("PGPORT")
                << "/" << env("PGDATABASE") << ", " << row["migrations"].as<long>()
                << " migrations, schema " << (row["schema"].isNull() ? "none" : row["schema"].as<std::string>()) << "\n"
                << "    auth         tokens from " << auth::issuerUrl() << "\n"
                << "    accounts     " << row["accounts"].as<long>() << " (" << admins << " admin)\n"
                << "    catalog      " << row["artists"].as<long>() << " artists, " << row["tracks"].as<long>()
                << " tracks" << (row["artists"].as<long>() == 0 ? " -- empty, the setup page seeds it" : "") << "\n"
                << "    quizzes      " << row["published"].as<long>() << " published, today's "
                << (row["today"].as<bool>() ? "is live" : "is not published yet") << "\n"
                << "\n    ports        frontend  " << url << "\n"
                << "                 backend   :" << port << ", proxied at " << url << "/api\n"
                << "                 supabase  " << env("SUPABASE_URL")
                << " -- auth /auth/v1, rest /rest/v1\n"
                << "    rate limits  " << (env("RATE_LIMIT", "on") == "off" ? "OFF (RATE_LIMIT=off)" : "on") << "\n"
                << "    body cap     " << maxBody / 1024 << " kB, database timeout "
                << (dbTimeout > 0 ? std::to_string(static_cast<int>(dbTimeout)) + " s" : "none") << "\n";
            LOG_INFO << out.str();
        },
        [port](const orm::DrogonDbException &e) {
            LOG_ERROR << "jamillion " JAM_VERSION " is listening on :" << port
                      << ", but the database at " << env("PGHOST") << ":" << env("PGPORT")
                      << " is not answering: " << e.base().what();
        });
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
    setup::configure(root);
    setup::registerRoutes();
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

    // The largest legitimate body is POST /api/quizzes: seven questions and
    // their expanded answer key, a few tens of kB. TLS and the static files are
    // Caddy's job, so this process only ever sees JSON.
    const auto maxBody = static_cast<size_t>(std::stoul(env("MAX_BODY_BYTES", "262144")));
    app().registerBeginningAdvice([=] { startupSummary(port, dbTimeout, maxBody); });
    app().setClientMaxBodySize(maxBody)
         .setClientMaxMemoryBodySize(maxBody)
         .addListener("0.0.0.0", port).setThreadNum(4).run();
}
