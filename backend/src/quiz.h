#pragma once
#include <drogon/drogon.h>
#include <filesystem>

namespace quiz {
// root is the directory holding .env: scripts/ and AUDIO_DIR are resolved from it.
void configure(const std::filesystem::path &root);
void registerRoutes();
}
