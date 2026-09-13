#pragma once

// Rate limiting. Drogon ships Hodor (sliding window, per-IP and per-user caps,
// URL-regex sub-limits) and RealIpResolver, so this module only configures them.
namespace limits { void configure(); }
