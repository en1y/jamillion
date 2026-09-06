cmake_minimum_required(VERSION 3.20)
project(jamillion CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Drogon CONFIG REQUIRED)

file(GLOB_RECURSE SRC CONFIGURE_DEPENDS src/*.cc)
add_executable(jamillion ${SRC})
target_link_libraries(jamillion PRIVATE Drogon::Drogon)
