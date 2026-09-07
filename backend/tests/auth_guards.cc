#include "auth.h"
#include <iostream>
#include <stdexcept>

int main() {
    auth::User user;
    auth::Moderator moderator;
    auth::Admin admin;
    const std::vector<drogon::HttpFilterBase *> guards{&user, &moderator, &admin};
    const std::vector<std::string> roles{"", "user", "moderator", "admin"};
    for (size_t role = 0; role < roles.size(); ++role) {
        for (size_t minimum = 0; minimum < guards.size(); ++minimum) {
            auto request = drogon::HttpRequest::newHttpRequest();
            request->attributes()->insert("identity", auth::Identity{
                role ? "signed-in-profile" : "", "test", role ? roles[role] : "user"});
            int result = 0;
            guards[minimum]->doFilter(request,
                [&](const drogon::HttpResponsePtr &response) { result = response->statusCode(); },
                [&]() { result = 200; });
            const int expected = role == 0 ? 401 : role > minimum ? 200 : 403;
            if (result != expected) throw std::runtime_error("Role guard allowed or rejected the wrong role");
        }
    }
    std::cout << "PASS: all 12 anonymous/user/moderator/admin guard combinations\n";
}
