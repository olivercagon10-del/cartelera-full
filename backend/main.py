"""
FastAPI server + Cartelera Scraper Argentina (La Nacion).
Todo en un solo archivo para evitar problemas con setuptools.
"""
from __future__ import annotations

import asyncio
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from urllib.parse import urljoin

import fastapi
import fastapi.middleware.cors
import httpx
from pydantic import BaseModel
from selectolax.parser import HTMLParser

# ========== SCRAPER ==========
BASE_URL = "https://www.lanacion.com.ar"
CARTELERA_URL = f"{BASE_URL}/cartelera-de-cine"
SOURCE_NAME = "La Nacion"

MOVIE_LINK_RE = re.compile(r"/cartelera-de-cine/pelicula/[a-z0-9-]+-pe\d+", re.I)
DATE_BODYCLASS_RE = re.compile(r"date-(\d{4})(\d{2})(\d{2})")
TIME_RE = re.compile(r"\b\d{1,2}:\d{2}\b")
FORMAT_KEYS = (
    "subtitulada", "subtitulado", "castellano", "doblada", "doblado",
    "imax", "3d", "2d", "4dx", "espanol",
)


@dataclass
class ScrapeProgress:
    state: str = "idle"
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    duration_ms: Optional[int] = None
    total_movies: int = 0
    processed_movies: int = 0
    total_records: int = 0
    week_key: Optional[str] = None
    logs: list[dict] = field(default_factory=list)
    error: Optional[str] = None

    def log(self, level: str, msg: str) -> None:
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "msg": msg,
        }
        self.logs.append(entry)
        if len(self.logs) > 200:
            self.logs = self.logs[-200:]


def iso_week_key(dt: Optional[datetime] = None) -> str:
    dt = dt or datetime.now(timezone.utc)
    year, week, _ = dt.isocalendar()
    return f"{year}-W{week:02d}"


def is_thursday(dt: Optional[datetime] = None) -> bool:
    dt = dt or datetime.now(timezone.utc)
    return dt.weekday() == 3


def _normalize_text(s: str) -> str:
    return " ".join(s.split()).strip()


def _parse_format_times(text: str) -> list[tuple[str, list[str]]]:
    text = text.lower()
    matches = []
    for kw in FORMAT_KEYS:
        for m in re.finditer(rf"\b{kw}\b", text, re.I):
            matches.append((m.start(), m.end(), kw))
    matches.sort()
    result: list[tuple[str, list[str]]] = []
    for i, (s, e, kw) in enumerate(matches):
        end = matches[i + 1][0] if i + 1 < len(matches) else len(text)
        chunk = text[e:end]
        times = TIME_RE.findall(chunk)
        if times:
            result.append((kw.upper(), times))
    if not result:
        times = TIME_RE.findall(text)
        if times:
            result.append(("SIN ESPECIFICAR", times))
    return result


def _extract_date_from_body(html: str) -> Optional[str]:
    m = DATE_BODYCLASS_RE.search(html)
    if not m:
        return None
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"


def current_week_thursday() -> str:
    today = datetime.now(timezone.utc).date()
    delta = today.weekday() - 3
    thursday = today - timedelta(days=delta) if delta >= 0 else today + timedelta(days=-delta)
    return thursday.isoformat()


async def _http_get(client: httpx.AsyncClient, url: str) -> Optional[str]:
    try:
        r = await client.get(url, timeout=20.0, follow_redirects=True)
        if r.status_code == 200 and r.text:
            return r.text
    except Exception:
        return None
    return None


async def fetch_movie_links(client: httpx.AsyncClient, html: Optional[str] = None) -> list[str]:
    if html is None:
        html = await _http_get(client, CARTELERA_URL)
    if not html:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for m in MOVIE_LINK_RE.finditer(html):
        path = m.group(0)
        if path not in seen:
            seen.add(path)
            out.append(urljoin(BASE_URL, path))
    return out


def parse_movie_page(html: str, url: str) -> dict:
    tree = HTMLParser(html)
    
    # Extract title
    movie = None
    strong_node = tree.css_first(".funciones__titulo strong, .funciones h3 strong")
    if strong_node:
        movie = _normalize_text(strong_node.text())
    if not movie:
        title_node = tree.css_first("section.ficha h1, section.ficha h2, .ficha h1, .ficha h2")
        if title_node:
            movie = _normalize_text(title_node.text())
    if not movie:
        t = tree.css_first("title")
        if t:
            txt = t.text()
            movie = _normalize_text(txt.split(".")[0])

    # Poster
    poster = ""
    img_node = tree.css_first("article.ficha__descrip img, .ficha__descrip img, .ficha img")
    if img_node:
        poster = img_node.attributes.get("src", "") or ""

    # Genre and duration
    genre = ""
    duration = ""
    h3_genre = tree.css_first("section.ficha > h3")
    if h3_genre:
        gtxt = _normalize_text(h3_genre.text())
        gm = re.search(r"Pel[ií]cula de\s+([^-\u00b7\n]+)", gtxt, re.I)
        if gm:
            genre = gm.group(1).strip()
        dm = re.search(r"Duraci[oó]n:\s*(\d+\s*min)", gtxt, re.I)
        if dm:
            duration = dm.group(1).strip()

    # Synopsis
    synopsis = ""
    syn_node = tree.css_first(".ficha__descrip__sinopsis dd, .sinopsis")
    if syn_node:
        synopsis = _normalize_text(syn_node.text())

    # Classification
    classification = ""
    for dl in tree.css(".ficha__descrip__items"):
        items_text = _normalize_text(dl.text())
        cm = re.search(r"Clasificaci[oó]n:\s*([^\.]+?)(?:Estreno|Sinopsis|$)", items_text, re.I)
        if cm:
            classification = cm.group(1).strip()

    date = _extract_date_from_body(html)

    # Cinema blocks
    cinemas: list[dict] = []
    for block in tree.css("article.sala, .funciones article, section.funciones > article"):
        cine_name_el = block.css_first("h2 a, h3 a, .sala__nombre a, header a")
        if not cine_name_el:
            continue
        cine_name = _normalize_text(cine_name_el.text())
        cine_href = cine_name_el.attributes.get("href") or ""
        cine_url = urljoin(BASE_URL, cine_href) if cine_href else ""
        addr_node = block.css_first("address, small")
        address = _normalize_text(addr_node.text()) if addr_node else ""
        block_text = _normalize_text(block.text())
        format_times = _parse_format_times(block_text)
        cinemas.append({
            "cinema": cine_name,
            "cinemaUrl": cine_url,
            "address": address,
            "formatTimes": format_times,
        })

    return {
        "movie": movie or "Sin titulo",
        "movieUrl": url,
        "poster": poster,
        "genre": genre,
        "duration": duration,
        "synopsis": synopsis,
        "classification": classification,
        "date": date or current_week_thursday(),
        "cinemas": cinemas,
    }


async def enrich_cinema_metadata(records: list[dict], progress: ScrapeProgress) -> None:
    urls = list({r["cinemaUrl"] for r in records if r.get("cinemaUrl")})
    if not urls:
        return
    progress.log("info", f"Enriqueciendo metadata de {len(urls)} cines")
    cinemas: dict[str, dict] = {}
    headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"}

    async with httpx.AsyncClient(headers=headers) as client:
        sem = asyncio.Semaphore(8)

        async def _one(u: str):
            async with sem:
                html = await _http_get(client, u)
                if not html:
                    return
                tree = HTMLParser(html)
                addr_node = tree.css_first("address")
                addr = ""
                city = ""
                if addr_node:
                    raw = _normalize_text(addr_node.text())
                    raw = re.sub(r"^\s*direcci[oó]n\s*:\s*", "", raw, flags=re.I)
                    parts = re.split(r"\s{2,}", raw)
                    parts = [p.strip() for p in parts if p.strip()]
                    if len(parts) >= 2:
                        addr = parts[0]
                        city = parts[-1]
                    else:
                        addr = raw
                cinemas[u] = {"address": addr, "city": city}

        tasks = [asyncio.create_task(_one(u)) for u in urls]
        await asyncio.gather(*tasks, return_exceptions=True)

    for r in records:
        u = r.get("cinemaUrl")
        meta = cinemas.get(u or "", {})
        r["address"] = meta.get("address") or r.get("address", "")
        r["city"] = meta.get("city") or r.get("city", "")
    progress.log("info", f"Metadata enriquecida para {len(cinemas)} cines")


async def scrape_cartelera(
    progress: ScrapeProgress,
    concurrency: int = 8,
) -> list[dict]:
    t0 = time.monotonic()
    progress.state = "running"
    progress.started_at = datetime.now(timezone.utc).isoformat()
    progress.week_key = iso_week_key()
    progress.log("info", f"Iniciando scraping (weekKey={progress.week_key})")

    headers = {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    async with httpx.AsyncClient(headers=headers, http2=False) as client:
        listing_html = await _http_get(client, CARTELERA_URL)
        
        movie_urls = await fetch_movie_links(client, listing_html)
        progress.total_movies = len(movie_urls)
        progress.log("info", f"Detectadas {len(movie_urls)} peliculas")
        
        if not movie_urls:
            progress.state = "error"
            progress.error = "No se encontraron peliculas en la cartelera"
            progress.log("error", progress.error)
            return []

        sem = asyncio.Semaphore(concurrency)
        results: list[dict] = []

        async def _one(url: str) -> Optional[dict]:
            async with sem:
                html = await _http_get(client, url)
                if not html:
                    progress.log("warn", f"No se pudo obtener: {url}")
                    return None
                try:
                    return parse_movie_page(html, url)
                except Exception as e:
                    progress.log("warn", f"Parse error {url}: {e}")
                    return None

        tasks = [asyncio.create_task(_one(u)) for u in movie_urls]
        for fut in asyncio.as_completed(tasks):
            data = await fut
            progress.processed_movies += 1
            if data:
                results.append(data)

        # Normalize to output format
        records: list[dict] = []
        for movie_data in results:
            for cine in movie_data.get("cinemas", []):
                for fmt, times in cine.get("formatTimes", []):
                    records.append({
                        "movie": movie_data["movie"],
                        "movieUrl": movie_data["movieUrl"],
                        "poster": movie_data["poster"],
                        "genre": movie_data["genre"],
                        "duration": movie_data["duration"],
                        "synopsis": movie_data["synopsis"],
                        "classification": movie_data["classification"],
                        "cinema": cine["cinema"],
                        "cinemaUrl": cine["cinemaUrl"],
                        "address": cine["address"],
                        "city": "",
                        "format": fmt,
                        "showtimes": times,
                        "date": movie_data["date"],
                        "source": SOURCE_NAME,
                    })

        progress.total_records = len(records)
        progress.log("info", f"Total records: {len(records)}")

    await enrich_cinema_metadata(records, progress)

    progress.finished_at = datetime.now(timezone.utc).isoformat()
    progress.duration_ms = int((time.monotonic() - t0) * 1000)
    progress.state = "done"
    progress.log("info", f"Scraping finalizado en {progress.duration_ms}ms")
    return records


# ========== FASTAPI APP ==========
SCRAPER_LOCK = asyncio.Lock()
CURRENT_PROGRESS: ScrapeProgress = ScrapeProgress()
CACHED_DATA: dict = {}


@asynccontextmanager
async def lifespan(_: fastapi.FastAPI):
    yield


app = fastapi.FastAPI(title="Cartelera Scraper", lifespan=lifespan)

app.add_middleware(
    fastapi.middleware.cors.CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RefreshResponse(BaseModel):
    started: bool
    message: str
    weekKey: str


class StatusResponse(BaseModel):
    state: str
    weekKey: Optional[str]
    lastWeekKey: Optional[str]
    isThursday: bool
    totalMovies: int
    processedMovies: int
    totalRecords: int
    startedAt: Optional[str]
    finishedAt: Optional[str]
    durationMs: Optional[int]
    error: Optional[str]
    cacheAge: Optional[int]


async def _do_scrape():
    global CACHED_DATA
    try:
        records = await scrape_cartelera(CURRENT_PROGRESS)
        CACHED_DATA = {
            "weekKey": CURRENT_PROGRESS.week_key,
            "records": records,
            "totalRecords": len(records),
            "totalMovies": CURRENT_PROGRESS.total_movies,
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
            "finishedAt": CURRENT_PROGRESS.finished_at,
            "durationMs": CURRENT_PROGRESS.duration_ms,
        }
    except Exception as e:
        CURRENT_PROGRESS.state = "error"
        CURRENT_PROGRESS.error = str(e)
        CURRENT_PROGRESS.log("error", f"Scraping failed: {e}")
    finally:
        SCRAPER_LOCK.release()


@app.post("/refresh")
async def refresh(force: bool = False) -> RefreshResponse:
    global CURRENT_PROGRESS
    wk = iso_week_key()

    if SCRAPER_LOCK.locked():
        return RefreshResponse(started=False, message="Scraping ya en progreso", weekKey=wk)

    cached_wk = CACHED_DATA.get("weekKey")
    if not force and cached_wk == wk:
        return RefreshResponse(started=False, message=f"Cache valida para {wk}", weekKey=wk)

    await SCRAPER_LOCK.acquire()
    CURRENT_PROGRESS = ScrapeProgress()
    asyncio.create_task(_do_scrape())
    return RefreshResponse(started=True, message="Scraping iniciado", weekKey=wk)


@app.post("/auto")
async def auto_refresh() -> RefreshResponse:
    wk = iso_week_key()
    cached_wk = CACHED_DATA.get("weekKey")
    should = is_thursday() or cached_wk != wk
    if not should:
        return RefreshResponse(started=False, message="No se requiere refresh", weekKey=wk)
    return await refresh(force=True)


@app.get("/status")
async def status() -> StatusResponse:
    cached_wk = CACHED_DATA.get("weekKey")
    scraped_at = CACHED_DATA.get("scrapedAt")
    age = None
    if scraped_at:
        try:
            dt = datetime.fromisoformat(scraped_at.replace("Z", "+00:00"))
            age = int((datetime.now(timezone.utc) - dt).total_seconds())
        except Exception:
            pass

    return StatusResponse(
        state=CURRENT_PROGRESS.state,
        weekKey=CURRENT_PROGRESS.week_key or cached_wk,
        lastWeekKey=cached_wk,
        isThursday=is_thursday(),
        totalMovies=CURRENT_PROGRESS.total_movies or CACHED_DATA.get("totalMovies", 0),
        processedMovies=CURRENT_PROGRESS.processed_movies,
        totalRecords=CURRENT_PROGRESS.total_records if CURRENT_PROGRESS.state == "running" else CACHED_DATA.get("totalRecords", 0),
        startedAt=CURRENT_PROGRESS.started_at,
        finishedAt=CURRENT_PROGRESS.finished_at or CACHED_DATA.get("finishedAt"),
        durationMs=CURRENT_PROGRESS.duration_ms or CACHED_DATA.get("durationMs"),
        error=CURRENT_PROGRESS.error,
        cacheAge=age,
    )


@app.get("/logs")
async def logs(limit: int = 60):
    return {"logs": CURRENT_PROGRESS.logs[-limit:]}


@app.get("/cartelera")
async def cartelera(
    fresh: bool = False,
    movie: Optional[str] = None,
    cinema: Optional[str] = None,
    city: Optional[str] = None,
    fmt: Optional[str] = None,
    limit: int = 1000,
):
    if not CACHED_DATA:
        return {"weekKey": None, "records": [], "count": 0, "cacheValid": False}

    records = CACHED_DATA.get("records", [])
    if movie:
        m = movie.lower()
        records = [r for r in records if m in r["movie"].lower()]
    if cinema:
        c = cinema.lower()
        records = [r for r in records if c in r["cinema"].lower()]
    if city:
        ci = city.lower()
        records = [r for r in records if ci in (r.get("city") or "").lower()]
    if fmt:
        f = fmt.lower()
        records = [r for r in records if f in r["format"].lower()]

    return {
        "weekKey": CACHED_DATA.get("weekKey"),
        "currentWeekKey": iso_week_key(),
        "cacheValid": CACHED_DATA.get("weekKey") == iso_week_key(),
        "count": len(records),
        "totalCount": CACHED_DATA.get("totalRecords", len(records)),
        "scrapedAt": CACHED_DATA.get("scrapedAt"),
        "records": records[:limit],
    }


@app.get("/movies")
async def movies():
    if not CACHED_DATA:
        return {"movies": []}
    seen = {}
    for r in CACHED_DATA.get("records", []):
        name = r["movie"]
        if name not in seen:
            seen[name] = {
                "movie": name,
                "url": r.get("movieUrl"),
                "poster": r.get("poster", ""),
                "genre": r.get("genre", ""),
                "duration": r.get("duration", ""),
                "synopsis": r.get("synopsis", ""),
                "classification": r.get("classification", ""),
                "cinemas": set(),
                "cities": set(),
                "formats": set(),
                "functions": 0,
            }
        seen[name]["cinemas"].add(r["cinema"])
        if r.get("city"):
            seen[name]["cities"].add(r["city"])
        seen[name]["formats"].add(r["format"])
        seen[name]["functions"] += len(r["showtimes"])
    out = [{
        "movie": v["movie"],
        "url": v["url"],
        "poster": v["poster"],
        "genre": v["genre"],
        "duration": v["duration"],
        "synopsis": v["synopsis"],
        "classification": v["classification"],
        "cinemas": len(v["cinemas"]),
        "cities": sorted(v["cities"]),
        "formats": sorted(v["formats"]),
        "functions": v["functions"],
    } for v in seen.values()]
    out.sort(key=lambda x: -x["functions"])
    return {"movies": out, "count": len(out)}


@app.get("/movie")
async def movie_detail(name: str):
    if not CACHED_DATA:
        return {"found": False}
    records = [r for r in CACHED_DATA.get("records", []) if r["movie"].lower() == name.lower()]
    if not records:
        return {"found": False}

    first = records[0]
    by_cinema: dict = {}
    for r in records:
        ckey = r["cinema"]
        if ckey not in by_cinema:
            by_cinema[ckey] = {
                "cinema": ckey,
                "cinemaUrl": r.get("cinemaUrl"),
                "address": r.get("address", ""),
                "city": r.get("city", ""),
                "formats": {},
            }
        fmt = r["format"]
        if fmt not in by_cinema[ckey]["formats"]:
            by_cinema[ckey]["formats"][fmt] = []
        by_cinema[ckey]["formats"][fmt].extend(r["showtimes"])

    cinemas_list = []
    for c in by_cinema.values():
        cinemas_list.append({
            "cinema": c["cinema"],
            "cinemaUrl": c["cinemaUrl"],
            "address": c["address"],
            "city": c["city"],
            "formats": [{"format": k, "showtimes": sorted(set(v))} for k, v in c["formats"].items()],
        })
    cinemas_list.sort(key=lambda x: x["cinema"])

    return {
        "found": True,
        "movie": first["movie"],
        "movieUrl": first.get("movieUrl"),
        "poster": first.get("poster", ""),
        "genre": first.get("genre", ""),
        "duration": first.get("duration", ""),
        "synopsis": first.get("synopsis", ""),
        "classification": first.get("classification", ""),
        "date": first.get("date"),
        "cinemas": cinemas_list,
        "totalCinemas": len(cinemas_list),
        "totalFunctions": sum(len(r["showtimes"]) for r in records),
    }


@app.get("/cinemas")
async def cinemas_list():
    if not CACHED_DATA:
        return {"cinemas": []}
    seen = {}
    for r in CACHED_DATA.get("records", []):
        cname = r["cinema"]
        if cname not in seen:
            seen[cname] = {
                "cinema": cname,
                "cinemaUrl": r.get("cinemaUrl"),
                "address": r.get("address", ""),
                "city": r.get("city", ""),
                "movies": set(),
                "functions": 0,
            }
        seen[cname]["movies"].add(r["movie"])
        seen[cname]["functions"] += len(r["showtimes"])
    out = [{
        "cinema": v["cinema"],
        "cinemaUrl": v["cinemaUrl"],
        "address": v["address"],
        "city": v["city"],
        "movies": len(v["movies"]),
        "functions": v["functions"],
    } for v in seen.values()]
    out.sort(key=lambda x: -x["functions"])
    return {"cinemas": out, "count": len(out)}


@app.get("/health")
async def health():
    return {"status": "ok"}
