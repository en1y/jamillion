#include "ratelimit.h"
#include <drogon/drogon.h>
#include <drogon/plugins/Hodor.h>
#include <drogon/plugins/RealIpResolver.h>
#include <cstdlib>
#include <string>
#include "auth.h"

using namespace drogon;

namespace {

std::string env(const char *key, const char *def) {
    const char *value = std::getenv(key);
    return value && *value ? value : def;
}

int cap(const char *key, int def) {
    const auto value = env(key, "");
    return value.empty() ? def : std::atoi(value.c_str());
}

// "127.0.0.1, ::1" -> a json array. Comma separated because that is what an
// environment variable can carry; anything richer wants the config file we do
// not have.
Json::Value list(const std::string &csv) {
    Json::Value out(Json::arrayValue);
    for (size_t at = 0; at <= csv.size();) {
        const auto comma = csv.find(',', at);
        const auto end = comma == std::string::npos ? csv.size() : comma;
        auto item = csv.substr(at, end - at);
        while (!item.empty() && item.front() == ' ') item.erase(item.begin());
        while (!item.empty() && item.back() == ' ') item.pop_back();
        if (!item.empty()) out.append(item);
        if (comma == std::string::npos) break;
        at = comma + 1;
    }
    return out;
}

Json::Value sub(const char *urls, const char *key, int ip, int user) {
    Json::Value one;
    one["urls"].append(urls);
    if (ip) one["ip_capacity"] = cap(key, ip);
    if (user) one["user_capacity"] = cap(key, user);
    return one;
}

}  // namespace

namespace limits {

void configure() {
    // ponytail: one switch rather than a cap per suite. The python integration
    // tests hammer the API in tight loops and would trip every limit below.
    if (env("RATE_LIMIT", "on") == "off") {
        LOG_WARN << "rate limiting disabled by RATE_LIMIT=off";
        return;
    }

    // Only a proxy we named may claim to speak for someone else. The default is
    // loopback plus Docker's bridge range, which is exactly where Caddy sits.
    // RealIpResolver parses these as in_addr_t, so they are IPv4 only: an entry
    // like "::1" throws out of initAndStart and takes the process with it.
    Json::Value resolver;
    resolver["trust_ips"] = list(env("TRUST_PROXY_IPS", "127.0.0.1,172.16.0.0/12"));
    app().addPlugin("drogon::plugin::RealIpResolver", {}, resolver);

    Json::Value hodor;
    hodor["algorithm"] = "sliding_window";
    hodor["time_unit"] = 60;
    hodor["use_real_ip_resolver"] = true;
    hodor["urls"].append("^/api/.*");
    hodor["ip_capacity"] = cap("RATE_IP", 120);
    // Deliberately no trust_ips here. The two plugins spell it the same and mean
    // opposite things: RealIpResolver's list is the proxies whose forwarded
    // address we believe, Hodor's is addresses exempt from every limit. Handing
    // Hodor the proxy range would exempt whatever Caddy forwards for whenever
    // the resolver comes up short -- a rate limiter that silently does nothing.

    // Each miss on /api/me INSERTs a players row, so it is the one anonymous
    // route that grows a table. suggest and known are unauthenticated ILIKE
    // scans. The rest are keyed per player, because a household shares an IP.
    hodor["sub_limits"].append(sub("^/api/me$", "RATE_ME", 10, 0));
    hodor["sub_limits"].append(sub("^/api/(suggest|known)", "RATE_LOOKUP", 60, 0));
    hodor["sub_limits"].append(sub("^/api/attempts", "RATE_PLAY", 0, 40));
    hodor["sub_limits"].append(sub("^/api/ideas$", "RATE_IDEAS", 5, 0));
    hodor["sub_limits"].append(sub("^/api/catalog$", "RATE_CATALOG", 0, 60));
    app().addPlugin("drogon::plugin::Hodor", {"drogon::plugin::RealIpResolver"}, hodor);

    // Plugins do not exist until the loop runs, hence the beginning advice.
    app().registerBeginningAdvice([] {
        auto *hodor = app().getPlugin<plugin::Hodor>();
        if (!hodor) return;
        // Hodor is a pre-routing advice, so it runs before auth::Optional has
        // inserted "identity" -- the cookie is the only passport available here.
        hodor->setUserIdGetter([](const HttpRequestPtr &req) -> std::optional<std::string> {
            const auto player = auth::cookiePlayer(req);
            if (player.empty()) return std::nullopt;
            return player;
        });
        // The same {"error": ...} shape every other refusal uses, so the
        // frontend renders a throttle without learning a new response.
        hodor->setRejectResponseFactory([](const HttpRequestPtr &) {
            return auth::error(k429TooManyRequests, "Too many requests. Wait a minute.");
        });
    });
}

}  // namespace limits
