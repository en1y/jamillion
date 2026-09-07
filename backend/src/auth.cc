#include "auth.h"
#include <jwt-cpp/jwt.h>
#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <stdexcept>

using namespace drogon;
namespace auth {
namespace {
std::string secret, issuer;
bool secureCookie = false;
constexpr int cookieLifetime = 365 * 24 * 60 * 60;

bool uuid(const std::string &s) {
    if (s.size() != 36) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (s[i] != '-') return false;
        } else if (!std::isxdigit(static_cast<unsigned char>(s[i]))) return false;
    }
    return true;
}

HttpResponsePtr error(HttpStatusCode status, const char *message) {
    Json::Value body;
    body["error"] = message;
    auto response = HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(status);
    response->addHeader("Cache-Control", "no-store");
    if (status == k401Unauthorized) response->addHeader("WWW-Authenticate", "Bearer");
    return response;
}

void guard(const HttpRequestPtr &req, FilterCallback cb, FilterChainCallback next,
           const std::string &minimum) {
    const auto &who = req->attributes()->get<Identity>("identity");
    if (who.id.empty()) return cb(error(k401Unauthorized, "Sign in required"));
    if (minimum == "admin" && who.role != "admin")
        return cb(error(k403Forbidden, "Admin access required"));
    if (minimum == "moderator" && who.role != "moderator" && who.role != "admin")
        return cb(error(k403Forbidden, "Moderator access required"));
    next();
}

std::string cookiePlayer(const HttpRequestPtr &req) {
    try {
        const auto &value = req->getCookie("jam_player");
        if (value.empty() || value.size() > 2048) return {};
        auto token = jwt::decode(value);
        // Separate signing domain: player cookies cannot be used as access tokens.
        jwt::verify().allow_algorithm(jwt::algorithm::hs256("jamillion-player:" + secret))
            .with_issuer("jamillion").with_audience("player").verify(token);
        if (!token.has_expires_at() || !uuid(token.get_subject())) return {};
        return token.get_subject();
    } catch (const std::exception &) { return {}; }
}

void me(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&cb) {
    const auto who = req->attributes()->get<Identity>("identity");
    const auto player = cookiePlayer(req);
    auto done = [who, cb](const orm::Result &rows) {
        const auto id = rows[0]["id"].as<std::string>();
        Json::Value body;
        body["player_id"] = id;
        body["authenticated"] = !who.id.empty();
        body["role"] = who.role;
        body["profile"] = Json::Value();
        if (!who.id.empty()) {
            body["profile"]["id"] = who.id;
            body["profile"]["username"] = who.username;
            body["profile"]["role"] = who.role;
        }
        auto response = HttpResponse::newHttpJsonResponse(body);
        response->addHeader("Cache-Control", "no-store");
        auto value = jwt::create().set_issuer("jamillion").set_audience("player")
            .set_subject(id).set_expires_at(std::chrono::system_clock::now() + std::chrono::seconds(cookieLifetime))
            .sign(jwt::algorithm::hs256("jamillion-player:" + secret));
        Cookie cookie("jam_player", value);
        cookie.setPath("/");
        cookie.setHttpOnly(true);
        cookie.setSecure(secureCookie);
        cookie.setSameSite(Cookie::SameSite::kLax);
        cookie.setMaxAge(cookieLifetime);
        response->addCookie(cookie);
        cb(response);
    };
    auto failed = [cb](const orm::DrogonDbException &) {
        cb(error(k503ServiceUnavailable, "Player service unavailable"));
    };
    auto create = [who, done, failed]() {
        app().getDbClient()->execSqlAsync(
            "INSERT INTO players (user_id) VALUES (nullif($1, '')::uuid) RETURNING id::text",
            done, failed, who.id);
    };
    if (player.empty()) return create();
    if (who.id.empty()) {
        // A linked cookie never grants access to an account after sign-out.
        app().getDbClient()->execSqlAsync(
            "SELECT id::text FROM players WHERE id = $1::uuid AND user_id IS NULL",
            [done, create](const orm::Result &rows) { if (rows.empty()) create(); else done(rows); },
            failed, player);
    } else {
        // Atomic ownership check prevents concurrent sign-ins claiming the same guest twice.
        app().getDbClient()->execSqlAsync(
            "UPDATE players SET user_id = $2::uuid WHERE id = $1::uuid "
            "AND (user_id IS NULL OR user_id = $2::uuid) RETURNING id::text",
            [done, create](const orm::Result &rows) { if (rows.empty()) create(); else done(rows); },
            failed, player, who.id);
    }
}
}

void configure() {
    const auto *key = std::getenv("SUPABASE_JWT_SECRET");
    const auto *url = std::getenv("SUPABASE_URL");
    if (!key || !*key || !url || !*url)
        throw std::runtime_error("SUPABASE_JWT_SECRET and SUPABASE_URL are required");
    secret = key;
    issuer = url;
    while (!issuer.empty() && issuer.back() == '/') issuer.pop_back();
    issuer += "/auth/v1";
    if (const auto *value = std::getenv("SUPABASE_JWT_ISSUER"); value && *value) issuer = value;
    const auto *secure = std::getenv("COOKIE_SECURE");
    secureCookie = secure && std::string(secure) == "true";
}

void Optional::doFilter(const HttpRequestPtr &req, FilterCallback &&cb, FilterChainCallback &&next) {
    const auto &header = req->getHeader("authorization");
    if (req->headers().find("authorization") == req->headers().end()) {
        req->attributes()->insert("identity", Identity{});
        return next();
    }
    std::string subject;
    try {
        auto scheme = header.substr(0, 7);
        std::transform(scheme.begin(), scheme.end(), scheme.begin(),
                       [](unsigned char c) { return std::tolower(c); });
        if (header.size() > 16384 || header.size() < 8 || scheme != "bearer ")
            throw std::runtime_error("Invalid authorization");
        auto token = jwt::decode(header.substr(7));
        jwt::verify().allow_algorithm(jwt::algorithm::hs256(secret))
            .with_issuer(issuer).with_audience("authenticated")
            .with_claim("role", jwt::claim(std::string("authenticated"))).verify(token);
        subject = token.get_subject();
        if (!token.has_expires_at() || !uuid(subject)) throw std::runtime_error("Invalid claims");
    } catch (const std::exception &) {
        return cb(error(k401Unauthorized, "Invalid or expired access token"));
    }
    app().getDbClient()->execSqlAsync(
        "SELECT id::text, username, role::text FROM profiles WHERE id = $1::uuid",
        [req, cb, next](const orm::Result &rows) {
            if (rows.empty()) return cb(error(k401Unauthorized, "Profile not found"));
            req->attributes()->insert("identity", Identity{rows[0]["id"].as<std::string>(),
                rows[0]["username"].as<std::string>(), rows[0]["role"].as<std::string>()});
            next();
        },
        [cb](const orm::DrogonDbException &) { cb(error(k503ServiceUnavailable, "Authentication service unavailable")); },
        subject);
}
void User::doFilter(const HttpRequestPtr &req, FilterCallback &&cb, FilterChainCallback &&next) {
    guard(req, std::move(cb), std::move(next), "user");
}
void Moderator::doFilter(const HttpRequestPtr &req, FilterCallback &&cb, FilterChainCallback &&next) {
    guard(req, std::move(cb), std::move(next), "moderator");
}
void Admin::doFilter(const HttpRequestPtr &req, FilterCallback &&cb, FilterChainCallback &&next) {
    guard(req, std::move(cb), std::move(next), "admin");
}
void registerRoutes() {
    app().registerHandler("/api/me", [](const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&cb) {
        me(req, std::move(cb));
    }, {Get, "auth::Optional"});
}
}
