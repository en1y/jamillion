#include <drogon/drogon.h>
#include <cstdlib>

using namespace drogon;

static std::string env(const char *k, const char *def = "")
{
    const char *v = std::getenv(k);
    return v ? v : def;
}

int main()
{
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
