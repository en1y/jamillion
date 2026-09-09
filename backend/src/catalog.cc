// The catalog query engine. One route answers every catalog question the editor
// can ask -- "Adele songs over a million listens", "the tracks on Coldplay's
// Parachutes, in running order", "British bands formed before 1980" -- by
// stacking filters and sorts over an allowlist of columns.
//
// The allowlist is the whole security boundary, the same trade /api/tables makes:
// no column name, table name or operator ever comes from the request, only a key
// that matched a row in kColumns. Values are always bound parameters.
#include "catalog.h"
#include "auth.h"
#include "util.h"
#include <algorithm>
#include <string>
#include <vector>

using namespace drogon;
namespace catalog {
namespace {

enum : unsigned { TRACKS = 1, ALBUMS = 2, ARTISTS = 4 };

// type: 't' text, 'n' number, 'd' date, 'b' boolean.
// in:   which entities may be asked about this column.
struct Column { const char *key; const char *sql; char type; unsigned in; };

// ponytail: artist.genres is a correlated subquery per row. Fine for a catalog
// this size; make it a LATERAL join if a 500-row page ever drags.
constexpr Column kColumns[] = {
    {"track.title",             "t.title",                             't', TRACKS},
    {"track.release_date",      "t.release_date",                      'd', TRACKS},
    {"track.year",              "extract(year FROM t.release_date)",   'n', TRACKS},
    {"track.duration_sec",      "(t.duration_ms / 1000)",              'n', TRACKS},
    {"track.track_number",      "t.track_number",                      'n', TRACKS},
    {"track.disc_number",       "t.disc_number",                       'n', TRACKS},
    {"track.explicit",          "t.explicit",                          'b', TRACKS},
    {"track.bpm",               "t.bpm",                               'n', TRACKS},
    {"track.deezer_rank",       "t.deezer_rank",                       'n', TRACKS},
    {"track.youtube_views",     "t.youtube_views",                     'n', TRACKS},
    {"track.ytmusic_plays",     "t.ytmusic_plays",                     'n', TRACKS},
    {"track.lastfm_listeners",  "t.lastfm_listeners",                  'n', TRACKS},
    {"track.lastfm_playcount",  "t.lastfm_playcount",                  'n', TRACKS},
    {"track.isrc",              "t.isrc",                              't', TRACKS},
    {"track.has_preview",       "(t.preview_url IS NOT NULL)",         'b', TRACKS},

    {"album.title",             "al.title",                            't', TRACKS | ALBUMS},
    {"album.album_type",        "al.album_type",                       't', TRACKS | ALBUMS},
    {"album.release_date",      "al.release_date",                     'd', TRACKS | ALBUMS},
    {"album.year",              "extract(year FROM al.release_date)",  'n', TRACKS | ALBUMS},
    {"album.total_tracks",      "al.total_tracks",                     'n', TRACKS | ALBUMS},
    {"album.label",             "al.label",                            't', TRACKS | ALBUMS},
    {"album.deezer_fans",       "al.deezer_fans",                      'n', TRACKS | ALBUMS},
    {"album.cover_url",         "al.cover_url",                        't', TRACKS | ALBUMS},

    {"artist.name",             "ar.name",                             't', TRACKS | ALBUMS | ARTISTS},
    {"artist.country",          "ar.country",                          't', TRACKS | ALBUMS | ARTISTS},
    {"artist.artist_type",      "ar.artist_type",                      't', TRACKS | ALBUMS | ARTISTS},
    {"artist.gender",           "ar.gender",                           't', TRACKS | ALBUMS | ARTISTS},
    {"artist.begin_year",       "ar.begin_year",                       'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.end_year",         "ar.end_year",                         'n', TRACKS | ALBUMS | ARTISTS},
    // MusicBrainz's begin is a birth date for a person and a formation date for a
    // group, so artist.begin_year alone says 1972 for Eminem, who was not rapping
    // yet. These three separate the two meanings and add the one the catalog can
    // answer for everybody: when their earliest record came out.
    {"artist.formed_year",      "CASE WHEN ar.artist_type = 'Group' THEN ar.begin_year END",
                                                                       'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.born_year",        "CASE WHEN ar.artist_type = 'Person' THEN ar.begin_year END",
                                                                       'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.first_release",    "fr.first_release",                    'd', TRACKS | ALBUMS | ARTISTS},
    {"artist.first_release_year", "extract(year FROM fr.first_release)",
                                                                       'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.global_rank",      "ar.global_rank",                      'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.lastfm_listeners", "ar.lastfm_listeners",                 'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.lastfm_playcount", "ar.lastfm_playcount",                 'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.deezer_fans",      "ar.deezer_fans",                      'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.ytmusic_listeners","ar.ytmusic_listeners",                'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.spotify_followers","ar.spotify_followers",                'n', TRACKS | ALBUMS | ARTISTS},
    {"artist.image_url",        "ar.image_url",                        't', TRACKS | ALBUMS | ARTISTS},
    {"artist.genres",           "(SELECT string_agg(g.name, ', ' ORDER BY g.name) "
                                " FROM artist_genres ag JOIN genres g ON g.id = ag.genre_id "
                                " WHERE ag.artist_id = ar.id)",        't', TRACKS | ALBUMS | ARTISTS},
};

struct Entity {
    const char *name;
    const char *label;
    unsigned bit;
    const char *from;
    const char *id;
    const char *order;      // the default sort, as an output-column expression
};

// The artist's earliest record in this catalog. A LATERAL rather than two
// subqueries in the select list: the same artist repeats down a page of tracks
// and Postgres memoises the join, which took a 500-row page from 86 ms to 1 ms.
// It is the earliest release *we hold*, so an artist known here only from a
// compilation reads late -- the catalog cannot know what it does not have.
constexpr const char *kFirstRelease =
    " LEFT JOIN LATERAL (SELECT min(coalesce(ft.release_date, fa.release_date)) AS first_release "
    "  FROM albums fa JOIN tracks ft ON ft.album_id = fa.id WHERE fa.artist_id = ar.id) fr ON true";

// tracks LEFT JOINs its album so a track whose album row went missing is still
// findable; albums and artists are always joined the other way round.
constexpr Entity kEntities[] = {
    {"tracks", "songs", TRACKS,
     "tracks t LEFT JOIN albums al ON al.id = t.album_id "
     "LEFT JOIN artists ar ON ar.id = al.artist_id",
     "t.id", "\"track.deezer_rank\" DESC NULLS LAST"},
    {"albums", "albums", ALBUMS,
     "albums al JOIN artists ar ON ar.id = al.artist_id",
     "al.id", "\"album.deezer_fans\" DESC NULLS LAST"},
    {"artists", "artists", ARTISTS,
     "artists ar", "ar.id", "\"artist.global_rank\" ASC NULLS LAST"},
};

// Which operators each datatype offers. The editor reads this list off
// /api/catalog/fields rather than keeping its own copy.
struct Op { const char *name; const char *types; bool needsValue; };
constexpr Op kOps[] = {
    {"contains", "t",    true},
    {"starts",   "t",    true},
    {"ends",     "t",    true},
    {"eq",       "tndb", true},
    {"ne",       "tndb", true},
    {"lt",       "nd",   true},
    {"lte",      "nd",   true},
    {"gt",       "nd",   true},
    {"gte",      "nd",   true},
    {"in",       "tn",   true},
    {"null",     "tndb", false},
    {"notnull",  "tndb", false},
};

const char *typeName(char type) {
    return type == 'n' ? "number" : type == 'd' ? "date" : type == 'b' ? "boolean" : "text";
}

const Entity *findEntity(const std::string &name) {
    for (const auto &e : kEntities) if (name == e.name) return &e;
    return nullptr;
}

const Column *findColumn(const std::string &key, unsigned bit) {
    for (const auto &c : kColumns) if ((c.in & bit) && key == c.key) return &c;
    return nullptr;
}

const Op *findOp(const std::string &name, char type) {
    for (const auto &o : kOps)
        if (name == o.name && std::string(o.types).find(type) != std::string::npos) return &o;
    return nullptr;
}

std::string quoted(const std::string &key) { return "\"" + key + "\""; }

// One WHERE clause. `slot` is the $n the value was bound to; ops that need no
// value ignore it. Nothing here is string-built from request text: `column` came
// out of kColumns and `op` out of kOps.
std::string predicate(const Column &column, const std::string &op, int slot) {
    const std::string x = column.sql, p = "$" + std::to_string(slot);
    const std::string cast = column.type == 'n' ? "::numeric"
                           : column.type == 'd' ? "::date"
                           : column.type == 'b' ? "::boolean" : "";

    if (op == "null")     return x + " IS NULL";
    if (op == "notnull")  return x + " IS NOT NULL";
    if (op == "contains") return x + " ILIKE '%' || " + p + " || '%'";
    if (op == "starts")   return x + " ILIKE " + p + " || '%'";
    if (op == "ends")     return x + " ILIKE '%' || " + p;
    if (op == "in") {
        // "adele, coldplay" -> one row per name, spaces around the commas trimmed.
        const std::string list = "string_to_array(regexp_replace(btrim(" +
                                 (column.type == 't' ? "lower(" + p + ")" : p) +
                                 "), '\\s*,\\s*', ',', 'g'), ',')";
        return column.type == 't' ? "lower(" + x + ") = ANY(" + list + ")"
                                  : x + " = ANY(" + list + "::numeric[])";
    }
    // Text compares case-insensitively; IS DISTINCT FROM so a null row is "not X".
    const std::string lhs = column.type == 't' ? "lower(" + x + ")" : x;
    const std::string rhs = column.type == 't' ? "lower(" + p + ")" : p + cast;
    if (op == "eq") return lhs + " = " + rhs;
    if (op == "ne") return lhs + " IS DISTINCT FROM " + rhs;
    const char *sign = op == "lt" ? "<" : op == "lte" ? "<=" : op == "gt" ? ">" : ">=";
    return x + " " + sign + " " + p + cast;
}

int clampInt(const Json::Value &value, int def, int lo, int hi) {
    return std::clamp(value.isIntegral() ? value.asInt() : def, lo, hi);
}

// The value of a filter, as text. Everything is bound as text and cast in SQL, so
// a JSON number, string or bool all arrive the same way.
std::string asText(const Json::Value &value) {
    if (value.isString()) return value.asString();
    if (value.isBool())   return value.asBool() ? "true" : "false";
    if (value.isNull())   return "";
    return value.asString();
}

// ---------------------------------------------------------------- routes

// GET /api/catalog/fields   every column, its datatype and the operators that
// datatype offers. The editor builds its whole filter UI out of this.
void fields(const HttpRequestPtr &, std::function<void(const HttpResponsePtr &)> &&cb) {
    Json::Value out;
    Json::Value entities(Json::arrayValue);
    for (const auto &e : kEntities) {
        Json::Value one;
        one["name"] = e.name;
        one["label"] = e.label;
        entities.append(one);
    }
    out["entities"] = entities;

    Json::Value operators;
    for (const char type : {'t', 'n', 'd', 'b'}) {
        Json::Value names(Json::arrayValue);
        for (const auto &o : kOps)
            if (std::string(o.types).find(type) != std::string::npos) names.append(o.name);
        operators[typeName(type)] = names;
    }
    out["operators"] = operators;

    Json::Value columns(Json::arrayValue);
    for (const auto &c : kColumns) {
        Json::Value one;
        one["key"] = c.key;
        one["type"] = typeName(c.type);
        Json::Value in(Json::arrayValue);
        for (const auto &e : kEntities) if (c.in & e.bit) in.append(e.name);
        one["entities"] = in;
        columns.append(one);
    }
    out["fields"] = columns;
    cb(json(out));
}

// POST /api/catalog
// { entity, filters: [{field, op, value}], sorts: [{field, dir}], limit, offset }
// Filters are ANDed. `in` covers the common "either of these" case, which is why
// there is no OR grouping: it would double the UI for a rare need.
void search(const HttpRequestPtr &req, std::function<void(const HttpResponsePtr &)> &&cb) {
    const auto body = req->getJsonObject();
    if (!body) return cb(auth::error(k400BadRequest, "Body must be JSON"));

    const auto *entity = findEntity((*body)["entity"].isString() ? (*body)["entity"].asString() : "");
    if (!entity) return cb(auth::error(k400BadRequest, "entity must be tracks, albums or artists"));

    std::vector<std::string> params, wheres;
    const auto &filters = (*body)["filters"];
    if (!filters.isNull() && !filters.isArray())
        return cb(auth::error(k400BadRequest, "filters must be an array"));
    for (const auto &filter : filters) {
        const auto key = filter["field"].isString() ? filter["field"].asString() : "";
        const auto *column = findColumn(key, entity->bit);
        if (!column)
            return cb(auth::error(k400BadRequest, ("No filterable field '" + key + "' on " + entity->name).c_str()));
        const auto name = filter["op"].isString() ? filter["op"].asString() : "";
        const auto *op = findOp(name, column->type);
        if (!op)
            return cb(auth::error(k400BadRequest,
                                  ("'" + name + "' is not an operator for a " + typeName(column->type) + " field").c_str()));
        if (op->needsValue) {
            const auto value = asText(filter["value"]);
            if (value.empty())
                return cb(auth::error(k400BadRequest, (key + " " + name + " needs a value").c_str()));
            params.push_back(value);
        }
        wheres.push_back(predicate(*column, name, static_cast<int>(params.size())));
    }

    std::vector<std::string> orders;
    const auto &sorts = (*body)["sorts"];
    if (!sorts.isNull() && !sorts.isArray())
        return cb(auth::error(k400BadRequest, "sorts must be an array"));
    for (const auto &sort : sorts) {
        const auto key = sort["field"].isString() ? sort["field"].asString() : "";
        if (!findColumn(key, entity->bit))
            return cb(auth::error(k400BadRequest, ("No sortable field '" + key + "' on " + entity->name).c_str()));
        const bool down = sort["dir"].isString() && sort["dir"].asString() == "desc";
        // NULLS LAST both ways: an unknown listen count is never the top answer.
        orders.push_back(quoted(key) + (down ? " DESC NULLS LAST" : " ASC NULLS LAST"));
    }
    if (orders.empty()) orders.emplace_back(entity->order);

    // Every column the entity has, so the editor can show and sort by any of them
    // without asking for a projection first.
    std::string select = std::string(entity->id) + " AS id, count(*) OVER () AS total";
    const std::string from = std::string(entity->from) + kFirstRelease;
    for (const auto &c : kColumns)
        if (c.in & entity->bit) select += ", " + std::string(c.sql) + " AS " + quoted(c.key);

    std::string inner, outer;
    for (const auto &order : orders) {
        inner += (inner.empty() ? "" : ", ") + order;
        outer += (outer.empty() ? "" : ", ") + ("t." + order);
    }

    // json_agg with its own ORDER BY: the subquery's order is not something the
    // aggregate is promised, so it is restated over the aliases.
    const std::string sql =
        "SELECT coalesce(json_agg(t ORDER BY " + outer + ", t.id), '[]')::text AS rows FROM ("
        "SELECT " + select + " FROM " + from +
        (wheres.empty() ? "" : " WHERE " + [&] {
            std::string all;
            for (const auto &where : wheres) all += (all.empty() ? "" : " AND ") + where;
            return all;
        }()) +
        " ORDER BY " + inner + ", id"
        " LIMIT $" + std::to_string(params.size() + 1) + "::int"
        " OFFSET $" + std::to_string(params.size() + 2) + "::int) t";

    params.push_back(std::to_string(clampInt((*body)["limit"], 50, 1, 500)));
    params.push_back(std::to_string(clampInt((*body)["offset"], 0, 0, 1000000)));

    // A runtime number of parameters, so the binder is filled in a loop rather
    // than by the variadic execSqlAsync. It runs when it goes out of scope.
    auto binder = *app().getDbClient() << sql;
    for (const auto &param : params) binder << param;
    const std::string name = entity->name;
    binder >> [cb, name](const orm::Result &result) {
        Json::Value rows;
        if (!parseJson(result[0]["rows"].as<std::string>(), rows))
            return cb(auth::error(k503ServiceUnavailable, "Catalog unavailable"));
        Json::Value out;
        out["entity"] = name;
        // count(*) OVER () rides along on every row; empty means nothing matched.
        out["total"] = rows.empty() ? 0 : rows[0]["total"].asInt();
        out["rows"] = rows;
        cb(json(out));
    } >> [cb](const orm::DrogonDbException &e) {
        LOG_ERROR << e.base().what();
        cb(auth::error(k503ServiceUnavailable, "Catalog unavailable"));
    };
}

}  // namespace

void registerRoutes() {
    app().registerHandler("/api/catalog/fields", &fields, {Get, "auth::Optional", "auth::Moderator"});
    app().registerHandler("/api/catalog", &search, {Post, "auth::Optional", "auth::Moderator"});
}

}  // namespace catalog
