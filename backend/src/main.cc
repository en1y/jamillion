#include <drogon/drogon.h>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include "admin.h"
#include "auth.h"
#include "catalog.h"
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
    const auto root = loadDotenv();
    try { auth::configure(); }
    catch (const std::exception &e) { LOG_ERROR << e.what(); return 1; }
    auth::registerRoutes();
    quiz::configure(root);
    quiz::registerRoutes();
    admin::registerRoutes();
    catalog::registerRoutes();
    // ponytail: no config.json, everything comes from .env / environment
    const auto port = static_cast<uint16_t>(std::stoi(env("PORT", "8080")));

    // DATABASE_URL=postgresql://user:pass@host:5432/db
    app().createDbClient("postgresql", env("PGHOST", "localhost"),
                         static_cast<unsigned short>(std::stoi(env("PGPORT", "5432"))),
                         env("PGDATABASE", "jamillion"), env("PGUSER", "jamillion"),
                         env("PGPASSWORD", "jamillion"), 2, "", "default");

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
                Json::Value j;
                j["ok"] = false;
                j["error"] = e.base().what();
                auto resp = HttpResponse::newHttpJsonResponse(j);
                resp->setStatusCode(k500InternalServerError);
                cb(resp);
            });
    });

    LOG_INFO << "jamillion listening on :" << port;
    app().addListener("0.0.0.0", port).setThreadNum(4).run();
}
