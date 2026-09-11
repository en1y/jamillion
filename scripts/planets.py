"""Render the flight's planets (and the Sun) as PNGs for frontend/public/planets/.

Procedural, not photos: a sphere lit from the upper left, a surface built from a
few octaves of value noise per body (bands for the gas giants, continents and
ice for Earth, craters for Mercury), an atmosphere rim where there is one, and
rings for Saturn drawn behind and in front of the disc. Re-run to regenerate:

    .venv/bin/python scripts/planets.py
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "frontend" / "public" / "planets"
SIZE = 512
rng = np.random.default_rng(7)


def noise(shape, scale, octaves=4, seed=0):
    """Value noise, tiling in x, in [0, 1]."""
    r = np.random.default_rng(seed)
    h, w = shape
    total = np.zeros(shape)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        gh, gw = max(2, int(h / scale) << o), max(2, int(w / scale) << o)
        grid = r.random((gh + 1, gw + 1))
        grid[:, -1] = grid[:, 0]                       # tile horizontally
        ys = np.linspace(0, gh, h, endpoint=False)
        xs = np.linspace(0, gw, w, endpoint=False)
        y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
        fy, fx = (ys - y0)[:, None], (xs - x0)[None, :]
        fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
        a = grid[y0][:, x0]; b = grid[y0][:, x0 + 1]
        c = grid[y0 + 1][:, x0]; d = grid[y0 + 1][:, x0 + 1]
        total += amp * ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy)
        norm += amp
        amp *= 0.5
    return total / norm


def sphere(size=SIZE):
    """Unit-sphere geometry per pixel: mask, normal, latitude and longitude."""
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size * 2 - 1
    v = 1 - (y + 0.5) / size * 2
    rr = u * u + v * v
    mask = rr <= 1
    z = np.sqrt(np.clip(1 - rr, 0, 1))
    lat = np.arcsin(np.clip(v, -1, 1))
    lon = np.arctan2(u, z)
    return mask, (u, v, z), lat, lon


def shade(rgb, mask, normal, light=(-0.55, 0.6, 0.58), ambient=0.12, rim=None):
    """Lambert lighting from the upper left, limb darkening, an optional atmosphere."""
    u, v, z = normal
    lx, ly, lz = np.array(light) / np.linalg.norm(light)
    lam = np.clip(u * lx + v * ly + z * lz, 0, 1)
    lit = ambient + (1 - ambient) * lam ** 0.9
    lit *= 0.75 + 0.25 * z ** 0.5                       # limb darkening
    out = rgb * lit[..., None]
    alpha = mask.astype(float)
    if rim is not None:
        color, strength = rim
        edge = np.clip(1 - z, 0, 1) ** 3 * lam ** 0.5 * strength
        out = out * (1 - edge[..., None]) + np.array(color) * edge[..., None]
    return out, alpha


def to_image(rgb, alpha):
    img = np.dstack([np.clip(rgb, 0, 1), np.clip(alpha, 0, 1)]) * 255
    return Image.fromarray(img.astype(np.uint8), "RGBA")


def mix(a, b, t):
    return np.array(a) * (1 - t[..., None]) + np.array(b) * t[..., None]


def bands(lat, lon, palette, wobble, seed):
    """Latitude bands nudged by noise so they wobble like a gas giant's."""
    h, w = lat.shape
    n = noise((h, w), 40, 4, seed)
    t = (lat / (np.pi / 2) + 1) / 2 + (n - 0.5) * wobble
    stops = np.linspace(0, 1, len(palette))
    rgb = np.zeros(lat.shape + (3,))
    for c in range(3):
        rgb[..., c] = np.interp(np.clip(t, 0, 1), stops, [p[c] for p in palette])
    return rgb


def planet(name, surface, rim=None, light=(-0.55, 0.6, 0.58)):
    mask, normal, lat, lon = sphere()
    rgb = surface(lat, lon, normal)
    rgb, alpha = shade(rgb, mask, normal, light, rim=rim)
    to_image(rgb, alpha).save(OUT / f"{name}.png")


def mercury(lat, lon, n):
    base = noise(lat.shape, 24, 5, 1)
    rgb = mix((0.42, 0.40, 0.38), (0.78, 0.75, 0.70), base)
    craters = noise(lat.shape, 10, 3, 2)
    rgb = mix(rgb, (0.28, 0.26, 0.25), np.clip((craters - 0.62) * 6, 0, 1))
    return rgb


def venus(lat, lon, n):
    swirl = noise(lat.shape, 60, 4, 3)
    rgb = bands(lat + (swirl - 0.5) * 0.6, lon, [(0.86, 0.72, 0.48), (0.98, 0.90, 0.72), (0.90, 0.78, 0.55), (0.99, 0.93, 0.78), (0.84, 0.70, 0.46)], 0.25, 4)
    return rgb


def earth(lat, lon, n):
    land = noise(lat.shape, 70, 6, 5)
    sea = np.array((0.10, 0.32, 0.72))
    green = mix((0.18, 0.46, 0.22), (0.62, 0.55, 0.32), noise(lat.shape, 30, 3, 6))
    is_land = np.clip((land - 0.52) * 14, 0, 1)
    rgb = mix(sea, green, is_land)
    ice = np.clip((np.abs(lat) - 1.15) * 8, 0, 1)
    rgb = mix(rgb, (0.95, 0.97, 1.0), ice)
    cloud = np.clip((noise(lat.shape, 45, 5, 7) - 0.55) * 5, 0, 1) * 0.85
    return mix(rgb, (1, 1, 1), cloud)


def mars(lat, lon, n):
    base = noise(lat.shape, 40, 5, 8)
    rgb = mix((0.55, 0.22, 0.12), (0.90, 0.55, 0.36), base)
    dark = np.clip((noise(lat.shape, 60, 3, 9) - 0.58) * 6, 0, 1)
    rgb = mix(rgb, (0.35, 0.15, 0.10), dark * 0.7)
    cap = np.clip((lat - 1.25) * 9, 0, 1) + np.clip((-lat - 1.35) * 9, 0, 1)
    return mix(rgb, (0.97, 0.95, 0.92), np.clip(cap, 0, 1))


def jupiter(lat, lon, n):
    pal = [(0.72, 0.52, 0.36), (0.93, 0.85, 0.72), (0.66, 0.42, 0.28), (0.95, 0.88, 0.76), (0.80, 0.58, 0.40),
           (0.97, 0.92, 0.82), (0.62, 0.40, 0.27), (0.92, 0.84, 0.70), (0.75, 0.55, 0.38), (0.94, 0.87, 0.74), (0.70, 0.50, 0.35)]
    rgb = bands(lat, lon, pal, 0.06, 10)
    u, v, z = n
    spot = np.exp(-(((u + 0.28) / 0.17) ** 2 + ((v + 0.30) / 0.09) ** 2))
    return mix(rgb, (0.80, 0.36, 0.26), np.clip(spot * 1.4, 0, 1))


def saturn_body(lat, lon, n):
    pal = [(0.78, 0.66, 0.45), (0.93, 0.85, 0.64), (0.84, 0.72, 0.50), (0.96, 0.90, 0.72), (0.86, 0.75, 0.53), (0.95, 0.89, 0.70), (0.80, 0.68, 0.47)]
    return bands(lat, lon, pal, 0.04, 11)


def uranus(lat, lon, n):
    rgb = bands(lat, lon, [(0.55, 0.82, 0.86), (0.70, 0.90, 0.92), (0.60, 0.86, 0.89), (0.74, 0.93, 0.95), (0.58, 0.84, 0.88)], 0.03, 12)
    return rgb


def neptune(lat, lon, n):
    rgb = bands(lat, lon, [(0.16, 0.26, 0.70), (0.30, 0.45, 0.92), (0.20, 0.32, 0.78), (0.34, 0.50, 0.95), (0.18, 0.28, 0.72)], 0.05, 13)
    u, v, z = n
    spot = np.exp(-(((u - 0.18) / 0.14) ** 2 + ((v - 0.12) / 0.09) ** 2))
    return mix(rgb, (0.08, 0.12, 0.42), np.clip(spot * 1.2, 0, 1))


def dwarf(dark, light, seed):
    def surface(lat, lon, n):
        base = noise(lat.shape, 30, 5, seed)
        return mix(dark, light, base)
    return surface


def rings(size=SIZE):
    """Saturn: a 2.2:1 image, the ring drawn behind the disc first, then the disc, then the ring in front."""
    w, h = int(size * 2.2), size
    y, x = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    tilt = np.deg2rad(-16)
    dx, dy = (x + 0.5 - cx), (y + 0.5 - cy)
    rx = dx * np.cos(tilt) + dy * np.sin(tilt)
    ry = -dx * np.sin(tilt) + dy * np.cos(tilt)
    rr = np.sqrt(rx ** 2 + (ry / 0.22) ** 2) / (size / 2)     # ellipse radius, in planet radii
    profile = noise((1, 600), 18, 4, 14)[0]
    band = np.interp(rr, np.linspace(1.15, 2.2, 600), profile)
    alpha = np.where((rr > 1.18) & (rr < 2.15), 0.35 + 0.6 * band, 0)
    alpha = np.where((rr > 1.75) & (rr < 1.82), alpha * 0.25, alpha)   # the Cassini gap
    ring_rgb = mix((0.75, 0.66, 0.48), (0.94, 0.88, 0.72), band)
    lit = np.clip(1 - np.abs(rx) / (size * 1.1) * 0.5, 0.5, 1)
    ring_rgb = ring_rgb * lit[..., None]
    front = ry > 0                                        # the near half of the ring
    canvas = np.zeros((h, w, 4))

    def blend(rgb, a, where):
        a = a * where
        canvas[..., :3] = canvas[..., :3] * (1 - a[..., None]) + rgb * a[..., None]
        canvas[..., 3] = canvas[..., 3] + a * (1 - canvas[..., 3])

    blend(ring_rgb, alpha, ~front)
    mask, normal, lat, lon = sphere(size)
    body, body_a = shade(saturn_body(lat, lon, normal), mask, normal)
    pad = np.zeros((h, w, 3)); pad_a = np.zeros((h, w))
    x0 = (w - size) // 2
    pad[:, x0:x0 + size] = body; pad_a[:, x0:x0 + size] = body_a
    # the planet's shadow on the near ring
    shadow = np.exp(-((dx / (size * 0.5)) ** 2)) * np.clip(-ry / 60, 0, 1)
    blend(pad, pad_a, np.ones_like(pad_a, dtype=bool))
    blend(ring_rgb * (1 - 0.6 * shadow[..., None]), alpha, front)
    to_image(canvas[..., :3], canvas[..., 3]).save(OUT / "saturn.png")


def sun(size=1024):
    y, x = np.mgrid[0:size, 0:size]
    u = (x + 0.5) / size * 2 - 1
    v = (y + 0.5) / size * 2 - 1
    rr = np.sqrt(u * u + v * v)
    mask = rr <= 1
    granules = noise((size, size), 5, 3, 15)
    cells = noise((size, size), 60, 3, 16)
    rgb = mix((1.0, 0.70, 0.25), (1.0, 0.95, 0.70), granules * 0.55 + cells * 0.45)
    spots = np.clip((noise((size, size), 30, 3, 17) - 0.86) * 22, 0, 1)   # a handful of small dark spots
    rgb = mix(rgb, (0.55, 0.18, 0.05), spots)
    # limb darkening, reddening toward the edge the way the real disc does
    z = np.sqrt(np.clip(1 - rr * rr, 0, 1))
    rgb = mix(rgb * (0.30 + 0.70 * z)[..., None], (0.85, 0.30, 0.08), (1 - z) ** 2 * 0.6)
    to_image(rgb, mask.astype(float)).save(OUT / "sun.png")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    planet("mercury", mercury)
    planet("venus", venus, rim=((1.0, 0.92, 0.75), 0.5))
    planet("earth", earth, rim=((0.55, 0.78, 1.0), 0.9))
    planet("mars", mars, rim=((0.9, 0.6, 0.45), 0.25))
    planet("jupiter", jupiter)
    planet("uranus", uranus, rim=((0.8, 0.98, 1.0), 0.5))
    planet("neptune", neptune, rim=((0.55, 0.65, 1.0), 0.6))
    planet("pluto", dwarf((0.45, 0.36, 0.30), (0.90, 0.84, 0.76), 18))
    planet("eris", dwarf((0.62, 0.64, 0.68), (0.95, 0.96, 0.98), 19))
    planet("sedna", dwarf((0.50, 0.25, 0.15), (0.88, 0.55, 0.40), 20))
    planet("none", dwarf((0.4, 0.4, 0.45), (0.7, 0.7, 0.75), 21))
    rings()
    sun()
    print("wrote", sorted(p.name for p in OUT.glob("*.png")))
