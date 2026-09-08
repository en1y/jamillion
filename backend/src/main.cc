#include <drogon/drogon.h>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include "admin.h"
#include "auth.h"
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

    // GET /api/tracks?q=&artist=&year=&min_rank=&limit=   quiz-editor search.
    // min_rank: only artists ranked at or above this (global_rank <= min_rank).
    app().registerHandler("/api/tracks", [](const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&cb) {
        auto num = [&](const char *k, int def, int lo, int hi) {
            const auto s = req->getParameter(k);
            const int v = s.empty() ? def : std::atoi(s.c_str());
            return std::clamp(v, lo, hi);
        };
        const auto q = req->getParameter("q"), artist = req->getParameter("artist");
        const int year = num("year", 0, 0, 9999), minRank = num("min_rank", 0, 0, 1000000),
                  limit = num("limit", 50, 1, 200);
        // ponytail: ILIKE substring scan, fine for a ~50k-track catalog; trigram index if it drags
        app().getDbClient()->execSqlAsync(
            "SELECT t.id, t.title, ar.name AS artist, ar.global_rank, al.title AS album, "
            "       t.release_date::text AS release_date, t.duration_ms, t.deezer_rank, "
            "       t.youtube_views, t.preview_url IS NOT NULL AS has_preview "
            "FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = al.artist_id "
            "WHERE ($1 = '' OR t.title ILIKE '%' || $1 || '%') "
            "  AND ($2 = '' OR ar.name ILIKE '%' || $2 || '%') "
            "  AND ($3::int = 0 OR extract(year FROM t.release_date) = $3::int) "
            "  AND ($4::int = 0 OR ar.global_rank <= $4::int) "
            "ORDER BY t.deezer_rank DESC NULLS LAST, t.id LIMIT $5::int",
            [cb](const orm::Result &r) {
                Json::Value out(Json::arrayValue);
                auto num = [](const orm::Field &f) { return f.isNull() ? Json::Value() : Json::Value(f.as<Json::Int64>()); };
                for (const auto &row : r) {
                    Json::Value j;
                    j["id"] = num(row["id"]);
                    j["title"] = row["title"].as<std::string>();
                    j["artist"] = row["artist"].as<std::string>();
                    j["global_rank"] = num(row["global_rank"]);
                    j["album"] = row["album"].as<std::string>();
                    j["release_date"] = row["release_date"].isNull() ? Json::Value() : Json::Value(row["release_date"].as<std::string>());
                    j["duration_ms"] = num(row["duration_ms"]);
                    j["deezer_rank"] = num(row["deezer_rank"]);
                    j["youtube_views"] = num(row["youtube_views"]);
                    j["has_preview"] = row["has_preview"].as<bool>();
                    out.append(j);
                }
                cb(HttpResponse::newHttpJsonResponse(out));
            },
            [cb](const orm::DrogonDbException &e) {
                Json::Value j;
                j["error"] = e.base().what();
                auto resp = HttpResponse::newHttpJsonResponse(j);
                resp->setStatusCode(k500InternalServerError);
                cb(resp);
            },
            q, artist, year, minRank, limit);
    }, {Get, "auth::Optional", "auth::Moderator"});

    // GET /api/albums?q=&artist=&year=&min_rank=&limit=   the other half of the
    // quiz-editor search. POST /api/quizzes needs an album_id for an album
    // question, and /api/tracks reports an album by title only, so before this
    // route the only way to find one was the admin-only table dump.
    app().registerHandler("/api/albums", [](const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&cb) {
        auto num = [&](const char *k, int def, int lo, int hi) {
            const auto s = req->getParameter(k);
            const int v = s.empty() ? def : std::atoi(s.c_str());
            return std::clamp(v, lo, hi);
        };
        const auto q = req->getParameter("q"), artist = req->getParameter("artist");
        const int year = num("year", 0, 0, 9999), minRank = num("min_rank", 0, 0, 1000000),
                  limit = num("limit", 50, 1, 200);
        // ponytail: the same ILIKE scan /api/tracks uses; index it when it drags
        app().getDbClient()->execSqlAsync(
            "SELECT al.id, al.title, ar.name AS artist, ar.global_rank, "
            "       al.release_date::text AS release_date, al.total_tracks, al.cover_url, al.deezer_fans "
            "FROM albums al JOIN artists ar ON ar.id = al.artist_id "
            "WHERE ($1 = '' OR al.title ILIKE '%' || $1 || '%') "
            "  AND ($2 = '' OR ar.name  ILIKE '%' || $2 || '%') "
            "  AND ($3::int = 0 OR extract(year FROM al.release_date) = $3::int) "
            "  AND ($4::int = 0 OR ar.global_rank <= $4::int) "
            "ORDER BY al.deezer_fans DESC NULLS LAST, al.id LIMIT $5::int",
            [cb](const orm::Result &r) {
                Json::Value out(Json::arrayValue);
                auto num = [](const orm::Field &f) { return f.isNull() ? Json::Value() : Json::Value(f.as<Json::Int64>()); };
                for (const auto &row : r) {
                    Json::Value j;
                    j["id"] = num(row["id"]);
                    j["title"] = row["title"].as<std::string>();
                    j["artist"] = row["artist"].as<std::string>();
                    j["global_rank"] = num(row["global_rank"]);
                    j["release_date"] = row["release_date"].isNull() ? Json::Value() : Json::Value(row["release_date"].as<std::string>());
                    j["total_tracks"] = num(row["total_tracks"]);
                    j["cover_url"] = row["cover_url"].isNull() ? Json::Value() : Json::Value(row["cover_url"].as<std::string>());
                    j["deezer_fans"] = num(row["deezer_fans"]);
                    out.append(j);
                }
                cb(HttpResponse::newHttpJsonResponse(out));
            },
            [cb](const orm::DrogonDbException &e) {
                Json::Value j;
                j["error"] = e.base().what();
                auto resp = HttpResponse::newHttpJsonResponse(j);
                resp->setStatusCode(k500InternalServerError);
                cb(resp);
            },
            q, artist, year, minRank, limit);
    }, {Get, "auth::Optional", "auth::Moderator"});

    LOG_INFO << "jamillion listening on :" << port;
    app().addListener("0.0.0.0", port).setThreadNum(4).run();
}
