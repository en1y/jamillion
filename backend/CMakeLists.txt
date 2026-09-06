cmake_minimum_required(VERSION 3.24)
project(jamillion CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Dependencies are declared here and fetched into build/_deps on first configure,
# maven-style. System needs only: cmake, a C++20 compiler, libpq, openssl, zlib, jsoncpp, uuid.
include(FetchContent)
set(BUILD_CTL OFF CACHE BOOL "" FORCE)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(BUILD_ORM ON CACHE BOOL "" FORCE)
set(BUILD_POSTGRESQL ON CACHE BOOL "" FORCE)
set(BUILD_MYSQL OFF CACHE BOOL "" FORCE)
set(BUILD_SQLITE OFF CACHE BOOL "" FORCE)
set(BUILD_REDIS OFF CACHE BOOL "" FORCE)
set(BUILD_BROTLI OFF CACHE BOOL "" FORCE)
set(BUILD_YAML_CONFIG OFF CACHE BOOL "" FORCE)
FetchContent_Declare(drogon
    GIT_REPOSITORY https://github.com/drogonframework/drogon.git
    GIT_TAG        v1.9.10
    GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(drogon)

file(GLOB_RECURSE SRC CONFIGURE_DEPENDS src/*.cc)
add_executable(jamillion ${SRC})
target_link_libraries(jamillion PRIVATE drogon)
