#pragma once
#include <drogon/drogon.h>
#include <memory>
#include <cctype>
#include <string>

// Small helpers shared by the quiz and admin routes.

inline drogon::HttpResponsePtr json(const Json::Value &body,
                                    drogon::HttpStatusCode status = drogon::k200OK) {
    auto response = drogon::HttpResponse::newHttpJsonResponse(body);
    response->setStatusCode(status);
    response->addHeader("Cache-Control", "no-store");
    return response;
}

// Drogon's PostgreSQL driver reports every failure as a plain orm::Failure, with
// no SQLSTATE to switch on, so bad input is caught before it reaches a query
// rather than sorted out of an exception afterwards.
inline bool isIsoDate(const std::string &s) {
    if (s.size() != 10) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        const bool dash = i == 4 || i == 7;
        if (dash != (s[i] == '-')) return false;
        if (!dash && !std::isdigit(static_cast<unsigned char>(s[i]))) return false;
    }
    return true;
}

inline Json::Value nullable(const drogon::orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<std::string>());
}

inline Json::Value nullableBool(const drogon::orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<bool>());
}

inline Json::Value nullableInt(const drogon::orm::Field &f) {
    return f.isNull() ? Json::Value() : Json::Value(f.as<Json::Int64>());
}

// Postgres types the rows for us with json_agg; this turns the text column back
// into a Json::Value. Shared by the raw table dump and the flight history.
inline bool parseJson(const std::string &text, Json::Value &out) {
    Json::CharReaderBuilder builder;
    const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
    std::string errors;
    if (reader->parse(text.data(), text.data() + text.size(), &out, &errors)) return true;
    LOG_ERROR << errors;
    return false;
}
