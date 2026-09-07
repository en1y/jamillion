#pragma once
#include <drogon/drogon.h>

namespace auth {
struct Identity {
    std::string id;
    std::string username;
    std::string role = "user";
};

// Run Optional first, then a role guard. Invalid supplied tokens never become guests.
class Optional : public drogon::HttpFilter<Optional> {
public:
    void doFilter(const drogon::HttpRequestPtr &, drogon::FilterCallback &&,
                  drogon::FilterChainCallback &&) override;
};
class User : public drogon::HttpFilter<User> {
public:
    void doFilter(const drogon::HttpRequestPtr &, drogon::FilterCallback &&,
                  drogon::FilterChainCallback &&) override;
};
class Moderator : public drogon::HttpFilter<Moderator> {
public:
    void doFilter(const drogon::HttpRequestPtr &, drogon::FilterCallback &&,
                  drogon::FilterChainCallback &&) override;
};
class Admin : public drogon::HttpFilter<Admin> {
public:
    void doFilter(const drogon::HttpRequestPtr &, drogon::FilterCallback &&,
                  drogon::FilterChainCallback &&) override;
};
void configure();
void registerRoutes();

// Shared with the quiz routes.
drogon::HttpResponsePtr error(drogon::HttpStatusCode status, const char *message);
// Shape check for a path or claim that must be a uuid.
bool isUuid(const std::string &s);
// The player id carried by a valid jam_player cookie, or empty.
std::string cookiePlayer(const drogon::HttpRequestPtr &req);
}
