#include "quiz.h"
#include "auth.h"
#include <array>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <map>
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

// Drogon's PostgreSQL driver reports every failure as a plain orm::Failure, with
// no SQLSTATE to switch on, so bad input is caught before it reaches a query
// rather than sorted out of an exception afterwards.
bool isIsoDate(const std::string &s) {
    if (s.size() != 10) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        const bool dash = i == 4 || i == 7;
        if (dash != (s[i] == '-')) return false;
        if (!dash && !std::isdigit(static_cast<unsigned char>(s[i]))) return false;
    }
    return true;
}

Json::Value nullable(const orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<std::string>());
}

Json::Value nullableBool(const orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<bool>());
}

Json::Value nullableInt(const orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<Json::Int64>());
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
        // A row still standing is one the DELETE spared because it has been played.
        // The UNIQUE on quiz_date would catch it next, but a plain orm::Failure cannot
        // be told apart from the database being down, so it is asked for directly.
        if (!(co_await db->execSqlCoro("SELECT 1 FROM quizzes WHERE quiz_date = $1::date", date)).empty())
            co_return auth::error(k409Conflict, "That day's quiz already has attempts");
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
// A moderator hears any quiz, published or not: previewing tomorrow's song
// question needs the clip before anyone may play it.
Task<HttpResponsePtr> audio(HttpRequestPtr req, long long questionId) {
    const auto &who = req->attributes()->get<auth::Identity>("identity");
    const bool moderator = who.role == "moderator" || who.role == "admin";
    auto db = app().getDbClient();
    try {
        const auto rows = co_await db->execSqlCoro(
            "SELECT t.id AS track_id, t.audio_path FROM questions q "
            "JOIN quizzes z ON z.id = q.quiz_id JOIN tracks t ON t.id = q.track_id "
            "WHERE q.id = $1::bigint AND ($2::bool OR (z.published AND z.quiz_date <= game_today()))",
            questionId, moderator);
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

// ---------------------------------------------------------------- moderation

// The whole quiz as a moderator sees it: prompts, the track behind a song
// question, and every answer with its verdict and guess count. Player routes
// still hand out neither track ids nor the answer key.
Task<HttpResponsePtr> getQuiz(HttpRequestPtr, std::string date) {
    if (!isIsoDate(date)) co_return auth::error(k400BadRequest, "quiz_date must be YYYY-MM-DD");
    auto db = app().getDbClient();
    try {
        const auto quizzes = co_await db->execSqlCoro(
            "SELECT id, quiz_date::text AS quiz_date, published, created_by::text AS created_by, "
            "  (SELECT count(*) FROM attempts a WHERE a.quiz_id = quizzes.id) AS attempts_started, "
            "  (SELECT count(*) FROM attempts a WHERE a.quiz_id = quizzes.id AND a.finished_at IS NOT NULL) "
            "    AS attempts_finished "
            "FROM quizzes WHERE quiz_date::text = $1",
            date);
        if (quizzes.empty()) co_return auth::error(k404NotFound, "No quiz on that date");
        const auto quizId = quizzes[0]["id"].as<long long>();

        Json::Value out;
        out["id"] = static_cast<Json::Int64>(quizId);
        out["quiz_date"] = quizzes[0]["quiz_date"].as<std::string>();
        out["published"] = quizzes[0]["published"].as<bool>();
        out["created_by"] = nullable(quizzes[0]["created_by"]);
        out["attempts_started"] = quizzes[0]["attempts_started"].as<int>();
        out["attempts_finished"] = quizzes[0]["attempts_finished"].as<int>();

        Json::Value questions(Json::arrayValue);
        std::map<long long, Json::ArrayIndex> index;   // question id -> its slot
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT q.id, q.position, q.qtype::text AS qtype, q.prompt, q.time_limit_sec, "
                 "  q.snippet_start_sec::float8 AS snippet_start_sec, "
                 "  q.snippet_len_sec::float8 AS snippet_len_sec, "
                 "  t.id AS track_id, t.title AS track_title, ar.name AS artist "
                 "FROM questions q LEFT JOIN tracks t ON t.id = q.track_id "
                 "LEFT JOIN albums al ON al.id = t.album_id LEFT JOIN artists ar ON ar.id = al.artist_id "
                 "WHERE q.quiz_id = $1::bigint ORDER BY q.position",
                 quizId)) {
            const auto id = row["id"].as<long long>();
            Json::Value question;
            question["id"] = static_cast<Json::Int64>(id);
            question["position"] = row["position"].as<int>();
            question["qtype"] = row["qtype"].as<std::string>();
            question["prompt"] = row["prompt"].as<std::string>();
            question["time_limit_sec"] = row["time_limit_sec"].as<int>();
            question["snippet_start_sec"] = row["snippet_start_sec"].isNull()
                                                ? Json::Value()
                                                : Json::Value(row["snippet_start_sec"].as<double>());
            question["snippet_len_sec"] = row["snippet_len_sec"].isNull()
                                              ? Json::Value()
                                              : Json::Value(row["snippet_len_sec"].as<double>());
            if (row["track_id"].isNull()) {
                question["track"] = Json::Value();
                question["audio"] = Json::Value();
            } else {
                Json::Value track;
                track["id"] = row["track_id"].as<Json::Int64>();
                track["title"] = row["track_title"].as<std::string>();
                track["artist"] = nullable(row["artist"]);
                question["track"] = track;
                question["audio"] = "/api/audio/" + row["id"].as<std::string>();
            }
            question["answers"] = Json::Value(Json::arrayValue);
            index[id] = questions.size();
            questions.append(question);
        }

        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT id, question_id, display, normalized, is_correct, tier_id, guess_count "
                 "FROM question_answers WHERE question_id IN "
                 "  (SELECT id FROM questions WHERE quiz_id = $1::bigint) "
                 "ORDER BY question_id, guess_count DESC, id",
                 quizId)) {
            const auto slot = index.find(row["question_id"].as<long long>());
            if (slot == index.end()) continue;
            Json::Value answer;
            answer["id"] = row["id"].as<Json::Int64>();
            answer["display"] = row["display"].as<std::string>();
            answer["normalized"] = row["normalized"].as<std::string>();
            answer["is_correct"] = nullableBool(row["is_correct"]);
            answer["tier_id"] = nullableInt(row["tier_id"]);
            answer["guess_count"] = row["guess_count"].as<int>();
            questions[slot->second]["answers"].append(answer);
        }
        out["questions"] = questions;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

// Publish or unpublish. Question edits still go through re-POSTing an unplayed quiz.
Task<HttpResponsePtr> patchQuiz(HttpRequestPtr req, std::string date) {
    if (!isIsoDate(date)) co_return auth::error(k400BadRequest, "quiz_date must be YYYY-MM-DD");
    const auto body = req->getJsonObject();
    if (!body || !(*body)["published"].isBool()) co_return auth::error(k400BadRequest, "published must be true or false");
    try {
        const auto rows = co_await app().getDbClient()->execSqlCoro(
            "UPDATE quizzes SET published = $2::bool WHERE quiz_date::text = $1 "
            "RETURNING id, quiz_date::text AS quiz_date, published",
            date, (*body)["published"].asBool());
        if (rows.empty()) co_return auth::error(k404NotFound, "No quiz on that date");
        Json::Value out;
        out["id"] = rows[0]["id"].as<Json::Int64>();
        out["quiz_date"] = rows[0]["quiz_date"].as<std::string>();
        out["published"] = rows[0]["published"].as<bool>();
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

Task<Json::Value> answerRow(long long answerId) {
    const auto rows = co_await app().getDbClient()->execSqlCoro(
        "SELECT id, question_id, display, normalized, is_correct, tier_id, guess_count "
        "FROM question_answers WHERE id = $1::bigint",
        answerId);
    Json::Value out;
    if (rows.empty()) co_return out;
    out["id"] = rows[0]["id"].as<Json::Int64>();
    out["question_id"] = rows[0]["question_id"].as<Json::Int64>();
    out["display"] = rows[0]["display"].as<std::string>();
    out["normalized"] = rows[0]["normalized"].as<std::string>();
    out["is_correct"] = nullableBool(rows[0]["is_correct"]);
    out["tier_id"] = nullableInt(rows[0]["tier_id"]);
    out["guess_count"] = rows[0]["guess_count"].as<int>();
    co_return out;
}

// Mark an answer correct, incorrect or back to awaiting review, and override its
// tier. Only the players who gave this very answer are re-scored: everyone else
// keeps the tier they were shown (docs/ROADMAP.md, v0.3 decisions).
// A key left out of the body keeps its current value, which is why the row is
// read first: null and absent mean different things here.
Task<HttpResponsePtr> patchAnswer(HttpRequestPtr req, long long answerId) {
    const auto body = req->getJsonObject();
    if (!body) co_return auth::error(k400BadRequest, "Body must be JSON");
    const bool hasCorrect = body->isMember("is_correct"), hasTier = body->isMember("tier_id");
    if (!hasCorrect && !hasTier) co_return auth::error(k400BadRequest, "is_correct or tier_id is required");
    if (hasCorrect && !(*body)["is_correct"].isBool() && !(*body)["is_correct"].isNull())
        co_return auth::error(k400BadRequest, "is_correct must be true, false or null");
    if (hasTier && !(*body)["tier_id"].isIntegral() && !(*body)["tier_id"].isNull())
        co_return auth::error(k400BadRequest, "tier_id must be a number or null");

    auto db = app().getDbClient();
    try {
        // The tier is checked here too: a foreign key violation would come back as an
        // untyped Failure, indistinguishable from the database being down.
        const auto current = co_await db->execSqlCoro(
            "SELECT qa.is_correct, qa.tier_id, "
            "  ($2 = '' OR EXISTS (SELECT 1 FROM rarity_tiers rt WHERE rt.id::text = $2)) AS tier_ok "
            "FROM question_answers qa WHERE qa.id = $1::bigint",
            answerId, hasTier && !(*body)["tier_id"].isNull() ? std::to_string((*body)["tier_id"].asInt())
                                                             : std::string{});
        if (current.empty()) co_return auth::error(k404NotFound, "No such answer");
        if (!current[0]["tier_ok"].as<bool>()) co_return auth::error(k400BadRequest, "No such tier_id");
        // Empty string is the null: nullif() in the statement turns it back into one.
        std::string correct = current[0]["is_correct"].isNull() ? std::string{}
                                                                : (current[0]["is_correct"].as<bool>() ? "true" : "false");
        std::string tier = current[0]["tier_id"].isNull() ? std::string{} : current[0]["tier_id"].as<std::string>();
        if (hasCorrect)
            correct = (*body)["is_correct"].isNull() ? std::string{} : ((*body)["is_correct"].asBool() ? "true" : "false");
        if (hasTier)
            tier = (*body)["tier_id"].isNull() ? std::string{} : std::to_string((*body)["tier_id"].asInt());

        const auto scored = co_await db->execSqlCoro(
            "SELECT review_answer($1::bigint, nullif($2, '')::bool, nullif($3, '')::smallint) AS rescored",
            answerId, correct, tier);
        auto out = co_await answerRow(answerId);
        if (out.empty()) co_return auth::error(k404NotFound, "No such answer");
        out["rescored"] = scored[0]["rescored"].isNull() ? 0 : scored[0]["rescored"].as<int>();
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

// Fold a duplicate into the canonical answer: its guesses and the players who
// gave it move over, then those players are re-scored against the merged count.
Task<HttpResponsePtr> mergeAnswer(HttpRequestPtr req, long long answerId) {
    const auto body = req->getJsonObject();
    if (!body || !(*body)["into"].isIntegral()) co_return auth::error(k400BadRequest, "into is required");
    const auto into = (*body)["into"].asInt64();
    try {
        const auto scored = co_await app().getDbClient()->execSqlCoro(
            "SELECT merge_answer($1::bigint, $2::bigint) AS rescored", answerId, into);
        if (scored[0]["rescored"].isNull())
            co_return auth::error(k400BadRequest, "Both answers must belong to the same question");
        auto out = co_await answerRow(into);
        out["rescored"] = scored[0]["rescored"].as<int>();
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Quiz service unavailable");
    }
}

// One player's flights, with every answer and the height it reached. A signed-in
// player has one row per browser, so a linked row reports the whole account.
Task<HttpResponsePtr> getPlayer(HttpRequestPtr, std::string playerId) {
    if (!auth::isUuid(playerId)) co_return auth::error(k404NotFound, "No such player");
    auto db = app().getDbClient();
    try {
        const auto rows = co_await db->execSqlCoro(
            "SELECT p.id::text AS id, p.user_id::text AS user_id, p.created_at::text AS created_at, "
            "  pr.username, pr.role::text AS role "
            "FROM players p LEFT JOIN profiles pr ON pr.id = p.user_id WHERE p.id = $1::uuid",
            playerId);
        if (rows.empty()) co_return auth::error(k404NotFound, "No such player");

        Json::Value out;
        out["id"] = rows[0]["id"].as<std::string>();
        out["user_id"] = nullable(rows[0]["user_id"]);
        out["created_at"] = rows[0]["created_at"].as<std::string>();
        out["username"] = nullable(rows[0]["username"]);
        out["role"] = nullable(rows[0]["role"]);

        Json::Value attempts(Json::arrayValue);
        std::map<long long, Json::ArrayIndex> index;
        std::string ids = "{";
        // A NULL user_id matches nothing, so a guest row reports only itself.
        for (const auto &row : co_await db->execSqlCoro(
                 "SELECT a.id, a.player_id::text AS player_id, z.quiz_date::text AS quiz_date, a.total_points, "
                 "  round(a.total_points * 0.1714, 2)::float8 AS height_au, "
                 "  a.started_at::text AS started_at, a.finished_at::text AS finished_at "
                 "FROM attempts a JOIN players p ON p.id = a.player_id JOIN quizzes z ON z.id = a.quiz_id "
                 "WHERE p.id = $1::uuid OR p.user_id = (SELECT user_id FROM players WHERE id = $1::uuid) "
                 "ORDER BY z.quiz_date DESC",
                 playerId)) {
            const auto id = row["id"].as<long long>();
            Json::Value attempt;
            attempt["id"] = static_cast<Json::Int64>(id);
            attempt["player_id"] = row["player_id"].as<std::string>();
            attempt["quiz_date"] = row["quiz_date"].as<std::string>();
            attempt["total_points"] = row["total_points"].as<int>();
            attempt["height_au"] = row["height_au"].as<double>();
            attempt["started_at"] = row["started_at"].as<std::string>();
            attempt["finished_at"] = nullable(row["finished_at"]);
            attempt["answers"] = Json::Value(Json::arrayValue);
            index[id] = attempts.size();
            if (ids.size() > 1) ids += ',';
            ids += std::to_string(id);
            attempts.append(attempt);
        }
        ids += '}';

        if (!index.empty()) {
            // raw_text '' is a skip or a timeout; the schema does not tell them apart.
            for (const auto &row : co_await db->execSqlCoro(
                     "SELECT aa.attempt_id, q.position, aa.raw_text, aa.points, "
                     "  aa.answered_at::text AS answered_at, qa.display AS matched, qa.is_correct, "
                     "  rt.name AS tier "
                     "FROM attempt_answers aa JOIN questions q ON q.id = aa.question_id "
                     "LEFT JOIN question_answers qa ON qa.id = aa.answer_id "
                     "LEFT JOIN rarity_tiers rt ON rt.id = aa.tier_id "
                     "WHERE aa.attempt_id = ANY($1::bigint[]) ORDER BY aa.attempt_id, q.position",
                     ids)) {
                const auto slot = index.find(row["attempt_id"].as<long long>());
                if (slot == index.end()) continue;
                Json::Value answer;
                answer["position"] = row["position"].as<int>();
                answer["raw_text"] = row["raw_text"].as<std::string>();
                answer["matched"] = nullable(row["matched"]);
                answer["is_correct"] = nullableBool(row["is_correct"]);
                answer["tier"] = nullable(row["tier"]);
                answer["points"] = row["points"].as<int>();
                answer["answered_at"] = row["answered_at"].as<std::string>();
                attempts[slot->second]["answers"].append(answer);
            }
        }
        out["attempts"] = attempts;
        co_return json(out);
    } catch (const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        co_return auth::error(k503ServiceUnavailable, "Player service unavailable");
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
    app().registerHandler("/api/audio/{1}", &audio, {Get, "auth::Optional"});
    app().registerHandler("/api/quizzes/{1}", &getQuiz, {Get, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/quizzes/{1}", &patchQuiz, {Patch, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/answers/{1}", &patchAnswer, {Patch, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/answers/{1}/merge", &mergeAnswer, {Post, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/players/{1}", &getPlayer, {Get, "auth::Optional", "auth::Moderator"});
}
}
