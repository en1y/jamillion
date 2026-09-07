#include "quiz.h"
#include "auth.h"
#include <array>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace drogon;
namespace quiz {
namespace {

std::filesystem::path rootDir, audioDir;

// An attempt is yours if it runs on your player row, or on any player row of
// your account when you are signed in. That is the one-flight-a-day rule across
// several browsers.
// nullif keeps '' from ever reaching a uuid cast: SQL does not short-circuit.
constexpr const char *kOwned =
    "(a.player_id = $2::uuid OR p.user_id = nullif($3, '')::uuid)";

HttpResponsePtr json(const Json::Value &body, HttpStatusCode status = k200OK) {
    auto response = HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(status);
    response->addHeader("Cache-Control", "no-store");
    return response;
}

bool isUniqueViolation(const orm::DrogonDbException &e) {
    return dynamic_cast<const orm::UniqueViolation *>(&e.base()) != nullptr;
}

std::string compact(const Json::Value &value) {
    Json::StreamWriterBuilder builder;
    builder["indentation"] = "";
    return Json::writeString(builder, value);
}

Json::Value nullable(const orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<std::string>());
}

// Download the 30 s preview through the existing seed-script path. It already
// re-resolves expired Deezer links, falls back to iTunes and sets tracks.audio_path.
// ponytail: blocks this IO thread for ~1-3 s per uncached track. It runs on the
// moderator's quiz save and once per track after that; move it to a worker thread
// if that ever shows up.
std::string ensureAudio(long long trackId) {
    const auto venv = rootDir / ".venv/bin/python";
    const std::string python = std::filesystem::exists(venv) ? venv.string() : "python3";
    // trackId is an integer, so nothing here can escape the quoting.
    const std::string command = "cd \"" + rootDir.string() + "\" && \"" + python +
                                "\" scripts/fetch_audio.py " + std::to_string(trackId) + " 2>/dev/null";
    std::string out;
    auto *pipe = popen(command.c_str(), "r");
    if (!pipe) return {};
    std::array<char, 256> buffer{};
    while (fgets(buffer.data(), buffer.size(), pipe)) out += buffer.data();
    if (pclose(pipe) != 0) return {};
    while (!out.empty() && (out.back() == '\n' || out.back() == '\r' || out.back() == ' ')) out.pop_back();
    return out;
}

// The player behind this request. Linking a guest row to an account happens in
// /api/me, so anything unexpected here is answered with "go there first".
Task<std::string> playerFor(HttpRequestPtr req) {
    const auto cookie = auth::cookiePlayer(req);
    if (cookie.empty()) co_return {};
    const auto &who = req->attributes()->get<auth::Identity>("identity");
    try {
        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "SELECT id::text FROM players WHERE id = $1::uuid "
            "AND user_id IS NOT DISTINCT FROM nullif($2, '')::uuid",
            cookie, who.id);
        co_return rows.empty() ? std::string{} : rows[0][0].as<std::string>();
    } catch (const orm::DrogonDbException &) {
        co_return {};
    }
}

// Serve the attempt's current question, stamping when it was first shown, and
// report the attempt's progress. Re-serving the same question keeps the original
// started_at, so a refresh does not hand out extra time.
Task<Json::Value> progress(long long attemptId) {
    auto db = app().getDbClient();
    const auto served = co_await db->execSqlCoro(
        "UPDATE attempts a SET question_started_at = coalesce(a.question_started_at, now()) "
        "FROM questions q "
        "WHERE a.id = $1::bigint AND q.quiz_id = a.quiz_id "
        "  AND q.position = (SELECT count(*) + 1 FROM attempt_answers aa WHERE aa.attempt_id = a.id) "
        "RETURNING a.quiz_id, a.total_points, "
        "  (SELECT count(*) FROM attempt_answers aa WHERE aa.attempt_id = a.id) AS answered, "
        "  q.id AS question_id, q.position, q.qtype::text AS qtype, q.prompt, q.time_limit_sec, "
        "  q.snippet_start_sec::float8 AS snippet_start_sec, q.snippet_len_sec::float8 AS snippet_len_sec, "
        "  to_char(a.question_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS started_at, "
        "  to_char((a.question_started_at + q.time_limit_sec * interval '1 second') AT TIME ZONE 'UTC', "
        "          'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') AS deadline",
        attemptId);

    Json::Value out;
    out["id"] = static_cast<Json::Int64>(attemptId);
    if (served.empty()) {  // every question answered, or the attempt is gone
        const auto rows = co_await db->execSqlCoro(
            "SELECT quiz_id, total_points, finished_at IS NOT NULL AS finished, "
            "  (SELECT count(*) FROM attempt_answers aa WHERE aa.attempt_id = attempts.id) AS answered "
            "FROM attempts WHERE id = $1::bigint",
            attemptId);
        if (rows.empty()) co_return Json::Value();
        out["quiz_id"] = rows[0]["quiz_id"].as<Json::Int64>();
        out["total_points"] = rows[0]["total_points"].as<int>();
        out["answered"] = rows[0]["answered"].as<int>();
        out["finished"] = rows[0]["finished"].as<bool>();
        out["question"] = Json::Value();
        co_return out;
    }

    const auto &row = served[0];
    out["quiz_id"] = row["quiz_id"].as<Json::Int64>();
    out["total_points"] = row["total_points"].as<int>();
    out["answered"] = row["answered"].as<int>();
    out["finished"] = false;
    Json::Value question;
    question["id"] = row["question_id"].as<Json::Int64>();
    question["position"] = row["position"].as<int>();
    question["qtype"] = row["qtype"].as<std::string>();
    question["prompt"] = row["prompt"].as<std::string>();
    question["time_limit_sec"] = row["time_limit_sec"].as<int>();
    question["started_at"] = nullable(row["started_at"]);
    question["deadline"] = nullable(row["deadline"]);
    // Never the track id: tracks are world readable through the anon key, so it
    // would give away the song. The clip is fetched by question id instead.
    if (question["qtype"] == "song") {
        question["snippet_start_sec"] = row["snippet_start_sec"].as<double>();
        if (!row["snippet_len_sec"].isNull())
            question["snippet_len_sec"] = row["snippet_len_sec"].as<double>();
        question["audio"] = "/api/audio/" + row["question_id"].as<std::string>();
    }
    out["question"] = question;
    co_return out;
}

// ---------------------------------------------------------------- moderator

const char *validate(const Json::Value &body) {
    if (!body.isObject()) return "Body must be a JSON object";
    if (!body["quiz_date"].isString()) return "quiz_date is required";
    const auto &questions = body["questions"];
    if (!questions.isArray() || questions.size() != 7) return "Exactly 7 questions are required";
    bool seen[8] = {};
    for (const auto &q : questions) {
        if (!q.isObject()) return "Each question must be an object";
        if (!q["position"].isIntegral()) return "position must be a number";
        const int position = q["position"].asInt();
        if (position < 1 || position > 7) return "position must be between 1 and 7";
        if (seen[position]) return "Duplicate question position";
        seen[position] = true;
        const auto type = q["qtype"].asString();
        if (type != "rarest" && type != "song") return "qtype must be rarest or song";
        if (!q["prompt"].isString() || q["prompt"].asString().empty() ||
            q["prompt"].asString().size() > 500) return "prompt must be 1 to 500 characters";
        if (q.isMember("time_limit_sec") &&
            (!q["time_limit_sec"].isIntegral() || q["time_limit_sec"].asInt() < 5 ||
             q["time_limit_sec"].asInt() > 60)) return "time_limit_sec must be between 5 and 60";
        if (type == "song" && (!q["track_id"].isIntegral() || !q["snippet_start_sec"].isNumeric() ||
                               !q["snippet_len_sec"].isNumeric()))
            return "song questions need track_id, snippet_start_sec and snippet_len_sec";
        const auto &answers = q["answers"];
        if (!answers.isArray() || answers.empty()) return "Each question needs at least one answer";
        for (const auto &a : answers) {
            if (!a.isObject() || !a["display"].isString() || a["display"].asString().empty() ||
                a["display"].asString().size() > 100) return "Each answer needs a display of 1 to 100 characters";
            if (a.isMember("tier_id") && !a["tier_id"].isIntegral()) return "tier_id must be a number";
        }
    }
    return nullptr;
}

Task<HttpResponsePtr> createQuiz(HttpRequestPtr req) {
    const auto body = req->getJsonObject();
    if (!body) co_return auth::error(k400BadRequest, "Body must be JSON");
    if (const auto *bad = validate(*body)) co_return auth::error(k400BadRequest, bad);

    // Cache every clip first: a quiz that cannot be played is not worth storing.
    for (const auto &q : (*body)["questions"]) {
        if (q["qtype"].asString() != "song") continue;
        const auto track = q["track_id"].asInt64();
        if (ensureAudio(track).empty()) {
            Json::Value error;
            error["error"] = "No preview available for track " + std::to_string(track);
            co_return json(error, k422UnprocessableEntity);
        }
    }

    const auto &who = req->attributes()->get<auth::Identity>("identity");
    const auto date = (*body)["quiz_date"].asString();
    const bool published = body->isMember("published") ? (*body)["published"].asBool() : true;
    auto db = app().getDbClient();
    try {
        // Replacing an unplayed quiz is allowed; once someone has flown it, it stands.
        // ponytail: two statements, so a crash between them drops a quiz nobody played.
        co_await db->execSqlCoro(
            "DELETE FROM quizzes WHERE quiz_date = $1::date "
            "AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.quiz_id = quizzes.id)", date);
        const auto rows = co_await db->execSqlCoro(
            "WITH qz AS ("
            "  INSERT INTO quizzes (quiz_date, published, created_by) "
            "  VALUES ($1::date, $2::bool, $3::uuid) RETURNING id), "
            "qs AS ("
            "  INSERT INTO questions (quiz_id, position, qtype, prompt, time_limit_sec, "
            "                         track_id, snippet_start_sec, snippet_len_sec) "
            "  SELECT qz.id, q.position, q.qtype::question_type, q.prompt, coalesce(q.time_limit_sec, 20), "
            "         q.track_id, q.snippet_start_sec, q.snippet_len_sec "
            "  FROM qz, jsonb_to_recordset($4::jsonb) AS q(position int, qtype text, prompt text, "
            "       time_limit_sec int, track_id bigint, snippet_start_sec numeric, snippet_len_sec numeric) "
            "  RETURNING id, position), "
            "ans AS ("
            "  INSERT INTO question_answers (question_id, normalized, display, is_correct, tier_id) "
            "  SELECT qs.id, normalize_answer(a.display), a.display, true, a.tier_id "
            "  FROM qs JOIN jsonb_to_recordset($4::jsonb) AS q(position int, answers jsonb) "
            "         ON q.position = qs.position, "
            "       jsonb_to_recordset(q.answers) AS a(display text, tier_id smallint)) "
            "SELECT id FROM qz",
            date, published, who.id, compact((*body)["questions"]));
        Json::Value out;
        out["id"] = rows[0][0].as<Json::Int64>();
        out["quiz_date"] = date;
        co_return json(out, k201Created);
    } catch (const orm::DrogonDbException &e) {
        if (isUniqueViolation(e)) co_return auth::error(k409Conflict, "That day's quiz already has attempts");
        Json::Value error;  // moderator-only route, so the database's own words help
        error["error"] = e.base().what();
        co_return json(error, k400BadRequest);
    }
}

// ---------------------------------------------------------------- players

Task<HttpResponsePtr> today(HttpRequestPtr req) {
    auto db = app().getDbClient();
    try {
        const auto quizzes = co_await db->execSqlCoro(
            "SELECT z.id, z.quiz_date::text AS quiz_date, "
            "  (SELECT count(*) FROM questions q WHERE q.quiz_id = z.id) AS question_count, "
            "  (SELECT count(*) FROM attempts att WHERE att.quiz_id = z.id AND att.finished_at IS NOT NULL) "
            "    AS players_finished "
            "FROM quizzes z WHERE z.quiz_date = game_today() AND z.published");
        if (quizzes.empty()) co_return auth::error(k404NotFound, "No quiz today");
        const auto quizId = quizzes[0]["id"].as<long long>();

        Json::Value out;
        out["id"] = static_cast<Json::Int64>(quizId);
        out["quiz_date"] = quizzes[0]["quiz_date"].as<std::string>();
        out["question_count"] = quizzes[0]["question_count"].as<int>();
        out["players_finished"] = quizzes[0]["players_finished"].as<int>();
        out["attempt"] = Json::Value();

        Json::Value tiers(Json::arrayValue);
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT name, points FROM rarity_tiers ORDER BY sort_order")) {
            Json::Value tier;
            tier["name"] = row["name"].as<std::string>();
            tier["points"] = row["points"].as<int>();
            tiers.append(tier);
        }
        out["tiers"] = tiers;

        const auto player = co_await playerFor(req);
        if (!player.empty()) {
            const auto &who = req->attributes()->get<auth::Identity>("identity");
            const auto rows = co_await db->execSqlCoro(
                "SELECT a.id, a.total_points, a.finished_at IS NOT NULL AS finished, "
                "  (SELECT count(*) FROM attempt_answers aa WHERE aa.attempt_id = a.id) AS answered "
                "FROM attempts a JOIN players p ON p.id = a.player_id "
                "WHERE a.quiz_id = $1::bigint AND " + std::string(kOwned) + " LIMIT 1",
                quizId, player, who.id);
            if (!rows.empty()) {
                Json::Value attempt;
                attempt["id"] = rows[0]["id"].as<Json::Int64>();
                attempt["total_points"] = rows[0]["total_points"].as<int>();
                attempt["answered"] = rows[0]["answered"].as<int>();
                attempt["finished"] = rows[0]["finished"].as<bool>();
                out["attempt"] = attempt;
            }
        }
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

Task<HttpResponsePtr> startAttempt(HttpRequestPtr req) {
    const auto player = co_await playerFor(req);
    if (player.empty()) co_return auth::error(k401Unauthorized, "No player passport: GET /api/me first");
    const auto &who = req->attributes()->get<auth::Identity>("identity");
    auto db = app().getDbClient();
    try {
        const auto quizzes = co_await db->execSqlCoro(
            "SELECT id FROM quizzes WHERE quiz_date = game_today() AND published");
        if (quizzes.empty()) co_return auth::error(k404NotFound, "No quiz today");
        const auto quizId = quizzes[0][0].as<long long>();

        const auto existing = co_await db->execSqlCoro(
            "SELECT a.id FROM attempts a JOIN players p ON p.id = a.player_id "
            "WHERE a.quiz_id = $1::bigint AND " + std::string(kOwned) + " LIMIT 1",
            quizId, player, who.id);
        bool created = false;
        long long attemptId;
        if (!existing.empty()) {
            attemptId = existing[0][0].as<long long>();
        } else {
            // ponytail: two browsers of one account starting in the same instant can
            // each get an attempt; the per-player UNIQUE still holds. Advisory lock if it matters.
            const auto rows = co_await db->execSqlCoro(
                "INSERT INTO attempts (player_id, quiz_id) VALUES ($1::uuid, $2::bigint) RETURNING id",
                player, quizId);
            attemptId = rows[0][0].as<long long>();
            created = true;
        }
        co_return json(co_await progress(attemptId), created ? k201Created : k200OK);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

Task<HttpResponsePtr> answer(HttpRequestPtr req, long long attemptId) {
    const auto body = req->getJsonObject();
    if (!body || !(*body)["question_id"].isIntegral()) co_return auth::error(k400BadRequest, "question_id is required");
    const auto text = (*body)["text"].isString() ? (*body)["text"].asString() : std::string{};
    if (text.size() > 200) co_return auth::error(k400BadRequest, "Answer is too long");
    const auto questionId = (*body)["question_id"].asInt64();

    const auto player = co_await playerFor(req);
    if (player.empty()) co_return auth::error(k401Unauthorized, "No player passport: GET /api/me first");
    const auto &who = req->attributes()->get<auth::Identity>("identity");
    auto db = app().getDbClient();
    try {
        const auto checks = co_await db->execSqlCoro(
            "SELECT a.question_started_at IS NULL AS unserved, "
            "  now() > a.question_started_at + ((q.time_limit_sec + 3) * interval '1 second') AS late "
            "FROM attempts a JOIN players p ON p.id = a.player_id "
            "JOIN questions q ON q.quiz_id = a.quiz_id AND q.id = $4::bigint "
            "WHERE a.id = $1::bigint AND a.finished_at IS NULL AND " + std::string(kOwned) +
            "  AND q.position = (SELECT count(*) + 1 FROM attempt_answers aa WHERE aa.attempt_id = a.id)",
            attemptId, player, who.id, questionId);
        if (checks.empty()) co_return auth::error(k409Conflict, "Not the current question");
        if (checks[0]["unserved"].as<bool>()) co_return auth::error(k409Conflict, "Question not served yet");
        // Past the timer, the answer still gets stored, just as a blank: no points,
        // and the guess does not move anyone's rarity share.
        const bool late = checks[0]["late"].as<bool>();
        std::string submitted = late ? std::string{} : text;

        const auto scored = co_await db->execSqlCoro(
            "SELECT points, tier, correct, total_points, finished FROM submit_answer($1::bigint, $2::bigint, $3)",
            attemptId, questionId, submitted);
        const auto &row = scored[0];

        Json::Value result;
        result["timed_out"] = late;
        result["correct"] = !row["correct"].isNull() && row["correct"].as<bool>();
        result["tier"] = nullable(row["tier"]);
        result["points"] = row["points"].as<int>();

        auto out = co_await progress(attemptId);
        out["result"] = result;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        if (isUniqueViolation(e)) co_return auth::error(k409Conflict, "Already answered");
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

// Keyed by question, never by track: the question id is the only handle a player
// is given for a song. Serves the whole 30 s clip.
// ponytail: the client is trusted to play only the snippet window. Trim it with
// ffmpeg at cache time if that ever turns into cheating.
Task<HttpResponsePtr> audio(HttpRequestPtr, long long questionId) {
    auto db = app().getDbClient();
    try {
        const auto rows = co_await db->execSqlCoro(
            "SELECT t.id AS track_id, t.audio_path FROM questions q "
            "JOIN quizzes z ON z.id = q.quiz_id JOIN tracks t ON t.id = q.track_id "
            "WHERE q.id = $1::bigint AND z.published AND z.quiz_date <= game_today()",
            questionId);
        if (rows.empty()) co_return auth::error(k404NotFound, "No audio for that question");
        auto name = rows[0]["audio_path"].isNull() ? std::string{} : rows[0]["audio_path"].as<std::string>();
        if (name.empty()) name = ensureAudio(rows[0]["track_id"].as<long long>());
        const auto path = audioDir / name;
        if (name.empty() || !std::filesystem::exists(path))
            co_return auth::error(k404NotFound, "No audio for that question");
        const bool mp3 = path.extension() == ".mp3";
        auto response = HttpResponse::newFileResponse(path.string(), "", CT_CUSTOM,
                                                      mp3 ? "audio/mpeg" : "audio/mp4");
        response->addHeader("Cache-Control", "private, max-age=86400");
        co_return response;
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Audio service unavailable");
    }
}
}  // namespace

void configure(const std::filesystem::path &root) {
    rootDir = root;
    const auto *configured = std::getenv("AUDIO_DIR");
    const std::filesystem::path dir(configured && *configured ? configured : "./data/audio");
    audioDir = dir.is_absolute() ? dir : root / dir;
}

void registerRoutes() {
    app().registerHandler("/api/quizzes", &createQuiz, {Post, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/quiz/today", &today, {Get, "auth::Optional"});
    app().registerHandler("/api/attempts", &startAttempt, {Post, "auth::Optional"});
    app().registerHandler("/api/attempts/{1}/answers", &answer, {Post, "auth::Optional"});
    app().registerHandler("/api/audio/{1}", &audio, {Get});
}
}
