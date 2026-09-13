#pragma once
#include <filesystem>

// First run, in the browser: until an admin exists and the catalog keys are
// saved, the site shows a setup page. The keys are kept in CONFIG_DIR, which only
// this process reads, and never leave it again; saving them starts the seeder.
namespace setup {
void configure(const std::filesystem::path &root);
void registerRoutes();
}
