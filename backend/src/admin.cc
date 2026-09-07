#include "admin.h"
#include "auth.h"
#include "util.h"
#include <algorithm>
#include <array>
#include <cstdio>
#include <map>
#include <string>

using namespace drogon;
namespace admin {
namespace {

// Tables an admin may dump through /api/tables. This list is the security
// boundary, which is why it is a fixed array and not a query against
// information_schema: auth.users holds password hashes and is never in it.
constexpr std::array<const char *, 16> kTables{
    "profiles", "players", "quizzes", "questions", "question_answers", "attempts",
    "attempt_answers", "rarity_tiers", "artists", "albums", "tracks", "genres",
    "artist_genres", "track_artists", "quiz_heights", "question_top_answers"};

bool allowedTable(const std::string &name) {
    return std::find(kTables.begin(), kTables.end(), name) != kTables.end();
}

bool isRole(const std::string &r) {
    return r == "user" || r == "moderator" || r == "admin";
}

int clampParam(const HttpRequestPtr &req, const char *key, int def, int lo, int hi) {
    const auto s = req->getParameter(key);
    return std::clamp(s.empty() ? def : std::atoi(s.c_str()), lo, hi);
}

HttpResponsePtr unavailable(const orm::DrogonDbException &e) {
    LOG_ERROR << e.base().what();
    return auth::error(k503ServiceUnavailable, "Admin service unavailable");
}

// ---------------------------------------------------------------- users

// GET /api/users?q=&role=&limit=&offset=
Task<HttpResponsePtr> listUsers(HttpRequestPtr req) {
    const auto role = req->getParameter("role");
    if (!role.empty() && !isRole(role))
        co_return auth::error(k400BadRequest, "role must be user, moderator or admin");
    try {
        Json::Value out(Json::arrayValue);
        for (const auto &row : co_await app().getDbClient()->execSqlCoro(
                 "SELECT p.id::text AS id, p.username, u.email, p.role::text AS role, "
                 "  p.created_at::text AS created_at, "
                 "  (SELECT count(*) FROM players pl WHERE pl.user_id = p.id) AS browsers, "
                 "  (SELECT count(*) FROM attempts a JOIN players pl ON pl.id = a.player_id "
                 "     WHERE pl.user_id = p.id) AS attempts "
                 "FROM profiles p JOIN auth.users u ON u.id = p.id "
                 "WHERE ($1 = '' OR p.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%') "
                 "  AND ($2 = '' OR p.role::text = $2) "
                 "ORDER BY p.created_at, p.id LIMIT $3::int OFFSET $4::int",
                 req->getParameter("q"), role, clampParam(req, "limit", 50, 1, 200),
                 clampParam(req, "offset", 0, 0, 1000000))) {
            Json::Value user;
            user["id"] = row["id"].as<std::string>();
            user["username"] = row["username"].as<std::string>();
            user["email"] = nullable(row["email"]);
            user["role"] = row["role"].as<std::string>();
            user["created_at"] = row["created_at"].as<std::string>();
            user["browsers"] = row["browsers"].as<int>();
            user["attempts"] = row["attempts"].as<int>();
            out.append(user);
        }
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

// The state an admin route needs before it changes a profile: does the row exist,
// what is its role, and is it the only admin left. Returns an empty result when
// there is no such profile.
Task<orm::Result> profileState(const std::string &userId) {
    co_return co_await app().getDbClient()->execSqlCoro(
        "SELECT role::text AS role, (SELECT count(*) FROM profiles WHERE role = 'admin') AS admins "
        "FROM profiles WHERE id = $1::uuid",
        userId);
}

// PATCH /api/users/{id}   {"role": "moderator"}
// ponytail: check-then-write, so two admins demoting each other in the same
// instant could leave none. Take a pg_advisory_xact_lock if that ever matters.
Task<HttpResponsePtr> patchUser(HttpRequestPtr req, std::string userId) {
    if (!auth::isUuid(userId)) co_return auth::error(k404NotFound, "No such user");
    const auto body = req->getJsonObject();
    if (!body || !(*body)["role"].isString() || !isRole((*body)["role"].asString()))
        co_return auth::error(k400BadRequest, "role must be user, moderator or admin");
    const auto role = (*body)["role"].asString();
    try {
        const auto current = co_await profileState(userId);
        if (current.empty()) co_return auth::error(k404NotFound, "No such user");
        if (current[0]["role"].as<std::string>() == "admin" && role != "admin" &&
            current[0]["admins"].as<int>() == 1)
            co_return auth::error(k409Conflict, "The last admin cannot be demoted");

        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "UPDATE profiles SET role = $2::user_role WHERE id = $1::uuid "
            "RETURNING id::text AS id, username, role::text AS role",
            userId, role);
        if (rows.empty()) co_return auth::error(k404NotFound, "No such user");
        Json::Value out;
        out["id"] = rows[0]["id"].as<std::string>();
        out["username"] = rows[0]["username"].as<std::string>();
        out["role"] = rows[0]["role"].as<std::string>();
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

// DELETE /api/users/{id}
// The account goes; the flights stay. profiles cascades from auth.users, which
// nulls players.user_id and quizzes.created_by, so attempts and answers survive
// de-identified and nobody's rarity share moves.
// ponytail: this works because the backend owns the database connection. On a
// hosted project whose role cannot touch auth.users, call
// DELETE {SUPABASE_URL}/auth/v1/admin/users/{id} with SUPABASE_SERVICE_ROLE_KEY.
Task<HttpResponsePtr> deleteUser(HttpRequestPtr, std::string userId) {
    if (!auth::isUuid(userId)) co_return auth::error(k404NotFound, "No such user");
    try {
        const auto current = co_await profileState(userId);
        if (current.empty()) co_return auth::error(k404NotFound, "No such user");
        if (current[0]["role"].as<std::string>() == "admin" && current[0]["admins"].as<int>() == 1)
            co_return auth::error(k409Conflict, "The last admin cannot be deleted");

        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "DELETE FROM auth.users WHERE id = $1::uuid RETURNING id::text AS id", userId);
        if (rows.empty()) co_return auth::error(k404NotFound, "No such user");
        Json::Value out;
        out["id"] = rows[0]["id"].as<std::string>();
        out["deleted"] = true;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

// ---------------------------------------------------------------- stats

// GET /api/quizzes/{date}/stats?top=
Task<HttpResponsePtr> quizStats(HttpRequestPtr req, std::string date) {
    if (!isIsoDate(date)) co_return auth::error(k400BadRequest, "quiz_date must be YYYY-MM-DD");
    const int top = clampParam(req, "top", 10, 1, 100);
    auto db = app().getDbClient();
    try {
        const auto quizzes = co_await db->execSqlCoro(
            "SELECT id, quiz_date::text AS quiz_date, published FROM quizzes WHERE quiz_date::text = $1",
            date);
        if (quizzes.empty()) co_return auth::error(k404NotFound, "No quiz on that date");
        const auto quizId = quizzes[0]["id"].as<long long>();

        Json::Value out;
        out["id"] = static_cast<Json::Int64>(quizId);
        out["quiz_date"] = quizzes[0]["quiz_date"].as<std::string>();
        out["published"] = quizzes[0]["published"].as<bool>();

        // The histogram is the view from v0.0.1: one row per distinct score.
        Json::Value heights(Json::arrayValue);
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT total_points, height_au::text AS height_au, players "
                 "FROM quiz_heights WHERE quiz_id = $1::bigint ORDER BY total_points",
                 quizId)) {
            Json::Value h;
            h["total_points"] = row["total_points"].as<int>();
            h["height_au"] = row["height_au"].as<std::string>();
            h["players"] = row["players"].as<int>();
            heights.append(h);
        }
        out["heights"] = heights;

        Json::Value questions(Json::arrayValue);
        std::map<long long, Json::ArrayIndex> index;   // question id -> its slot
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT q.id, q.position, q.qtype::text AS qtype, q.prompt, "
                 "  count(aa.id) AS answered, "
                 "  count(aa.id) FILTER (WHERE aa.raw_text = '') AS skipped, "
                 "  count(aa.id) FILTER (WHERE qa.is_correct) AS correct "
                 "FROM questions q LEFT JOIN attempt_answers aa ON aa.question_id = q.id "
                 "LEFT JOIN question_answers qa ON qa.id = aa.answer_id "
                 "WHERE q.quiz_id = $1::bigint GROUP BY q.id ORDER BY q.position",
                 quizId)) {
            const auto id = row["id"].as<long long>();
            Json::Value question;
            question["id"] = static_cast<Json::Int64>(id);
            question["position"] = row["position"].as<int>();
            question["qtype"] = row["qtype"].as<std::string>();
            question["prompt"] = row["prompt"].as<std::string>();
            question["answered"] = row["answered"].as<int>();
            question["skipped"] = row["skipped"].as<int>();
            question["correct"] = row["correct"].as<int>();
            question["top_answers"] = Json::Value(Json::arrayValue);
            index[id] = questions.size();
            questions.append(question);
        }

        // One query for every question's top answers, ranked in the database.
        // The share divides by all answers stored for the question, skips included,
        // which is the denominator submit_answer() and rescore_answer() use.
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT question_id, id, display, is_correct, tier_id, guess_count, share FROM ( "
                 "  SELECT qa.question_id, qa.id, qa.display, qa.is_correct, qa.tier_id, qa.guess_count, "
                 "    round(qa.guess_count::numeric / greatest((SELECT count(*) FROM attempt_answers aa "
                 "      WHERE aa.question_id = qa.question_id), 1), 4)::text AS share, "
                 "    row_number() OVER (PARTITION BY qa.question_id "
                 "      ORDER BY qa.guess_count DESC, qa.id) AS rn "
                 "  FROM question_answers qa JOIN questions q ON q.id = qa.question_id "
                 "  WHERE q.quiz_id = $1::bigint) t "
                 "WHERE rn <= $2::int ORDER BY question_id, rn",
                 quizId, top)) {
            const auto slot = index.find(row["question_id"].as<long long>());
            if (slot == index.end()) continue;
            Json::Value answer;
            answer["id"] = row["id"].as<Json::Int64>();
            answer["display"] = row["display"].as<std::string>();
            answer["is_correct"] = nullableBool(row["is_correct"]);
            answer["tier_id"] = nullableInt(row["tier_id"]);
            answer["guess_count"] = row["guess_count"].as<int>();
            answer["share"] = row["share"].as<std::string>();
            questions[slot->second]["top_answers"].append(answer);
        }
        out["questions"] = questions;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

// ---------------------------------------------------------------- raw tables

// GET /api/tables
Task<HttpResponsePtr> listTables(HttpRequestPtr) {
    Json::Value out(Json::arrayValue);
    for (const auto *name : kTables) out.append(name);
    co_return json(out);
}

// GET /api/tables/{name}?limit=&offset=
// ponytail: an allowlisted dump with offset paging. No ?where=, no free SQL: the
// allowlist is the whole security boundary and stays that way.
Task<HttpResponsePtr> readTable(HttpRequestPtr req, std::string name) {
    if (!allowedTable(name)) co_return auth::error(k404NotFound, "No such table");
    try {
        // The name is interpolated only after the allowlist matched it, so there
        // is no user text in this statement. Postgres types the rows, not us.
        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "SELECT coalesce(json_agg(t), '[]')::text AS rows FROM "
            "(SELECT * FROM " + name + " ORDER BY 1 LIMIT $1::int OFFSET $2::int) t",
            clampParam(req, "limit", 100, 1, 500), clampParam(req, "offset", 0, 0, 100000000));

        Json::Value parsed;
        const auto body = rows[0]["rows"].as<std::string>();
        Json::CharReaderBuilder builder;
        const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
        std::string errors;
        if (!reader->parse(body.data(), body.data() + body.size(), &parsed, &errors)) {
            LOG_ERROR << errors;
            co_return auth::error(k503ServiceUnavailable, "Admin service unavailable");
        }
        Json::Value out;
        out["table"] = name;
        out["rows"] = parsed;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

// ---------------------------------------------------------------- tiers

// PATCH /api/tiers/{id}   any of name, points, max_share.
// Rows cannot be added or deleted: six tiers are the game, and both
// question_answers.tier_id and attempt_answers.tier_id point here.
// A key left out of the body keeps its current value, so the row is read first.
// Scores already awarded do not move: points are frozen at answer time
// (docs/ROADMAP.md, v0.3 decisions).
Task<HttpResponsePtr> patchTier(HttpRequestPtr req, int tierId) {
    const auto body = req->getJsonObject();
    if (!body) co_return auth::error(k400BadRequest, "Body must be JSON");
    const bool hasName = body->isMember("name"), hasPoints = body->isMember("points"),
               hasShare = body->isMember("max_share");
    if (!hasName && !hasPoints && !hasShare)
        co_return auth::error(k400BadRequest, "name, points or max_share is required");
    if (hasName && (!(*body)["name"].isString() || (*body)["name"].asString().empty()))
        co_return auth::error(k400BadRequest, "name must be a non-empty string");
    if (hasPoints && (!(*body)["points"].isIntegral() || (*body)["points"].asInt() < 0 ||
                      (*body)["points"].asInt() > 32767))
        co_return auth::error(k400BadRequest, "points must be between 0 and 32767");
    if (hasShare && (!(*body)["max_share"].isNumeric() || (*body)["max_share"].asDouble() <= 0 ||
                     (*body)["max_share"].asDouble() > 1))
        co_return auth::error(k400BadRequest, "max_share must be greater than 0 and at most 1");

    auto db = app().getDbClient();
    try {
        // The name clash is checked here too: a unique violation would come back
        // as an untyped Failure, indistinguishable from the database being down.
        const auto current = co_await db->execSqlCoro(
            "SELECT rt.name, rt.points, rt.max_share::text AS max_share, "
            "  ($2 = '' OR NOT EXISTS (SELECT 1 FROM rarity_tiers o WHERE o.name = $2 AND o.id <> rt.id)) "
            "    AS name_ok "
            "FROM rarity_tiers rt WHERE rt.id = $1::int",
            tierId, hasName ? (*body)["name"].asString() : std::string{});
        if (current.empty()) co_return auth::error(k404NotFound, "No such tier");
        if (!current[0]["name_ok"].as<bool>())
            co_return auth::error(k409Conflict, "A tier with that name exists");

        std::string name = current[0]["name"].as<std::string>();
        std::string points = current[0]["points"].as<std::string>();
        std::string share = current[0]["max_share"].as<std::string>();
        if (hasName) name = (*body)["name"].asString();
        if (hasPoints) points = std::to_string((*body)["points"].asInt());
        if (hasShare) {
            char buffer[16];
            std::snprintf(buffer, sizeof buffer, "%.4f", (*body)["max_share"].asDouble());
            share = buffer;
        }

        const auto rows = co_await db->execSqlCoro(
            "UPDATE rarity_tiers SET name = $2, points = $3::int, max_share = $4::numeric "
            "WHERE id = $1::int "
            "RETURNING id, name, points, sort_order, max_share::text AS max_share",
            tierId, name, points, share);
        if (rows.empty()) co_return auth::error(k404NotFound, "No such tier");
        Json::Value out;
        out["id"] = rows[0]["id"].as<int>();
        out["name"] = rows[0]["name"].as<std::string>();
        out["points"] = rows[0]["points"].as<int>();
        out["sort_order"] = rows[0]["sort_order"].as<int>();
        out["max_share"] = rows[0]["max_share"].as<std::string>();
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        co_return unavailable(e);
    }
}

}   // namespace

void registerRoutes() {
    app().registerHandler("/api/users", &listUsers, {Get, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/users/{1}", &patchUser, {Patch, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/users/{1}", &deleteUser, {Delete, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/quizzes/{1}/stats", &quizStats, {Get, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/tables", &listTables, {Get, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/tables/{1}", &readTable, {Get, "auth::Optional", "auth::Admin"});
    app().registerHandler("/api/tiers/{1}", &patchTier, {Patch, "auth::Optional", "auth::Admin"});
}
}   // namespace admin
