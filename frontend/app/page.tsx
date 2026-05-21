"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import axios from "axios";
import { toast } from "sonner";
import {
  Film,
  Building2,
  RefreshCw,
  Search,
  X,
  Clock,
  MapPin,
  Terminal,
  ChevronDown,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";

// Types
interface Status {
  state: string;
  weekKey: string | null;
  lastWeekKey: string | null;
  isThursday: boolean;
  totalMovies: number;
  processedMovies: number;
  totalRecords: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  cacheAge: number | null;
}

interface Movie {
  movie: string;
  url: string;
  poster: string;
  genre: string;
  duration: string;
  synopsis: string;
  classification: string;
  cinemas: number;
  cities: string[];
  formats: string[];
  functions: number;
}

interface Cinema {
  cinema: string;
  cinemaUrl: string;
  address: string;
  city: string;
  movies: number;
  functions: number;
}

interface MovieDetail {
  found: boolean;
  movie: string;
  movieUrl: string;
  poster: string;
  genre: string;
  duration: string;
  synopsis: string;
  classification: string;
  date: string;
  cinemas: {
    cinema: string;
    cinemaUrl: string;
    address: string;
    city: string;
    formats: { format: string; showtimes: string[] }[];
  }[];
  totalCinemas: number;
  totalFunctions: number;
}

interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

// MovieCard Component
function MovieCard({ movie, onClick }: { movie: Movie; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group relative overflow-hidden rounded-lg bg-zinc-900/60 border border-zinc-800 hover:border-amber-300/30 transition-all duration-200 text-left w-full focus:outline-none focus:ring-2 focus:ring-amber-300/40"
    >
      <div className="aspect-[2/3] relative">
        {movie.poster ? (
          <img
            src={movie.poster}
            alt={movie.movie}
            className="w-full h-full object-cover"
            crossOrigin="anonymous"
          />
        ) : (
          <div className="w-full h-full bg-zinc-800 flex items-center justify-center">
            <Film className="w-12 h-12 text-zinc-700" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
        {movie.genre && (
          <div className="absolute top-2 left-2">
            <Badge className="bg-zinc-950/70 backdrop-blur text-amber-300 border-amber-300/30 text-[9px] uppercase tracking-wider font-mono">
              {movie.genre}
            </Badge>
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <h3 className="font-bold text-zinc-100 text-sm leading-tight line-clamp-2 mb-1.5">
            {movie.movie}
          </h3>
          <div className="flex items-center gap-2 text-[10px] text-zinc-300 font-mono">
            <span className="flex items-center gap-1">
              <Building2 className="w-3 h-3" />
              {movie.cinemas}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {movie.functions}
            </span>
            {movie.duration && (
              <span className="text-zinc-400">· {movie.duration}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}

// Progress Bar Component
function ProgressBar({ progress, total }: { progress: number; total: number }) {
  const pct = total > 0 ? (progress / total) * 100 : 0;
  return (
    <div className="w-full h-1 bg-zinc-800 rounded-full overflow-hidden">
      <div
        className="h-full bg-amber-300 transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function CarteleraPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [movies, setMovies] = useState<Movie[]>([]);
  const [cinemas, setCinemas] = useState<Cinema[]>([]);
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [movieDetail, setMovieDetail] = useState<MovieDetail | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [view, setView] = useState<"movies" | "cinemas">("movies");

  const loadAll = useCallback(async () => {
    try {
      const [s, m, ci, l] = await Promise.all([
        axios.get("/api/status"),
        axios.get("/api/movies"),
        axios.get("/api/cinemas"),
        axios.get("/api/logs?limit=80"),
      ]);
      setStatus(s.data);
      setMovies(m.data.movies || []);
      setCinemas(ci.data.cinemas || []);
      setLogs(l.data.logs || []);
    } catch (e) {
      console.error("Error loading data:", e);
    }
  }, []);

  const loadLight = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([
        axios.get("/api/status"),
        axios.get("/api/logs?limit=80"),
      ]);
      setStatus(s.data);
      setLogs(l.data.logs || []);
    } catch {}
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (status?.state !== "running") return;
    const id = setInterval(loadLight, 1500);
    return () => clearInterval(id);
  }, [status?.state, loadLight]);

  const [prevState, setPrevState] = useState<string | null>(null);
  useEffect(() => {
    if (prevState === "running" && status?.state === "done") {
      loadAll();
      toast.success("Cartelera actualizada", {
        description: `${status.totalRecords} funciones disponibles`,
      });
    }
    if (prevState === "running" && status?.state === "error") {
      toast.error("Scraping fallo", { description: status.error || undefined });
    }
    setPrevState(status?.state || null);
  }, [status?.state, status?.error, status?.totalRecords, prevState, loadAll]);

  const handleRefresh = async () => {
    if (refreshing || status?.state === "running") return;
    setRefreshing(true);
    try {
      const r = await axios.post("/api/refresh?force=true");
      if (r.data.started) {
        toast.info("Actualizando cartelera...", {
          description: `Semana ${r.data.weekKey}`,
        });
        setTimeout(loadLight, 500);
      } else {
        toast.warning(r.data.message);
      }
    } catch {
      toast.error("Error al iniciar");
    } finally {
      setRefreshing(false);
    }
  };

  const openMovie = async (movie: Movie) => {
    setSelectedMovie(movie);
    setMovieDetail(null);
    try {
      const r = await axios.get(
        `/api/movie?name=${encodeURIComponent(movie.movie)}`
      );
      setMovieDetail(r.data);
    } catch {
      toast.error("Error al cargar detalles");
    }
  };

  // Filters
  const allGenres = useMemo(
    () =>
      Array.from(new Set(movies.map((m) => m.genre).filter(Boolean))).sort(),
    [movies]
  );

  const filteredMovies = useMemo(() => {
    let result = movies;
    if (search) {
      const s = search.toLowerCase();
      result = result.filter((m) => m.movie.toLowerCase().includes(s));
    }
    if (genreFilter) {
      result = result.filter((m) => m.genre === genreFilter);
    }
    return result;
  }, [movies, search, genreFilter]);

  const filteredCinemas = useMemo(() => {
    if (!search) return cinemas;
    const s = search.toLowerCase();
    return cinemas.filter(
      (c) =>
        c.cinema.toLowerCase().includes(s) ||
        (c.city || "").toLowerCase().includes(s) ||
        (c.address || "").toLowerCase().includes(s)
    );
  }, [cinemas, search]);

  const isRunning = status?.state === "running";

  return (
    <div className="min-h-screen px-4 py-6 md:px-8 md:py-10 max-w-7xl mx-auto">
      {/* Header */}
      <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-zinc-100 tracking-tight flex items-center gap-3">
            <Film className="w-7 h-7 text-amber-300" />
            Cartelera.ar
          </h1>
          <p className="text-xs uppercase tracking-widest text-zinc-500 mt-1 font-mono">
            Scraper de cartelera · La Nacion ·{" "}
            {status?.weekKey || "sin datos"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLogsOpen(!logsOpen)}
            className="border-zinc-800 text-zinc-400 hover:text-amber-300 hover:border-amber-300/30"
          >
            <Terminal className="w-4 h-4 mr-1" />
            Logs
          </Button>
          <Button
            onClick={handleRefresh}
            disabled={refreshing || isRunning}
            className="bg-amber-300 text-zinc-950 hover:bg-amber-200 disabled:opacity-50"
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw
                className={`w-4 h-4 mr-2 ${refreshing ? "animate-spin" : ""}`}
              />
            )}
            {isRunning ? "Scraping..." : "Actualizar"}
          </Button>
        </div>
      </header>

      {/* Status Bar */}
      {isRunning && (
        <div className="mb-6 p-4 rounded-lg bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between mb-2 text-xs font-mono">
            <span className="text-amber-300">
              Procesando {status?.processedMovies}/{status?.totalMovies}{" "}
              peliculas
            </span>
            <span className="text-zinc-500">
              {status?.totalRecords} registros
            </span>
          </div>
          <ProgressBar
            progress={status?.processedMovies || 0}
            total={status?.totalMovies || 1}
          />
        </div>
      )}

      {/* Logs Panel */}
      <Collapsible open={logsOpen} onOpenChange={setLogsOpen}>
        <CollapsibleContent>
          <div className="mb-6 p-4 rounded-lg bg-zinc-950 border border-zinc-800 font-mono text-xs">
            <div className="flex items-center justify-between mb-3">
              <span className="text-zinc-500 uppercase tracking-widest">
                Live Logs
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLogsOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 h-6 px-2"
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
            <ScrollArea className="h-48">
              <div className="space-y-1">
                {logs.length === 0 ? (
                  <p className="text-zinc-600">Sin logs</p>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-zinc-600 shrink-0">
                        {new Date(log.ts).toLocaleTimeString("es-AR")}
                      </span>
                      <span
                        className={
                          log.level === "error"
                            ? "text-red-400"
                            : log.level === "warn"
                            ? "text-amber-400"
                            : "text-zinc-400"
                        }
                      >
                        [{log.level}]
                      </span>
                      <span className="text-zinc-300">{log.msg}</span>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* View Toggle + Search */}
      <section className="mb-6">
        <div className="flex flex-col md:flex-row gap-4 md:items-center md:justify-between">
          <div className="flex gap-2">
            <Button
              variant={view === "movies" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("movies")}
              className={
                view === "movies"
                  ? "bg-amber-300 text-zinc-950"
                  : "border-zinc-800 text-zinc-400"
              }
            >
              <Film className="w-4 h-4 mr-1" />
              Peliculas ({movies.length})
            </Button>
            <Button
              variant={view === "cinemas" ? "default" : "outline"}
              size="sm"
              onClick={() => setView("cinemas")}
              className={
                view === "cinemas"
                  ? "bg-amber-300 text-zinc-950"
                  : "border-zinc-800 text-zinc-400"
              }
            >
              <Building2 className="w-4 h-4 mr-1" />
              Cines ({cinemas.length})
            </Button>
          </div>
          {status?.durationMs && status.state !== "running" && (
            <span className="text-[10px] uppercase tracking-widest text-zinc-600 font-mono">
              Ultimo scrape: {(status.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>

        {/* Search */}
        <div className="relative mt-4">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-600" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              view === "movies"
                ? "Buscar pelicula..."
                : "Buscar cine, ciudad o direccion..."
            }
            className="h-12 pl-11 pr-4 bg-zinc-900/60 border-zinc-800 text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-amber-300/40 focus-visible:border-amber-300/40 text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Genre filter chips */}
        {view === "movies" && allGenres.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            <button
              onClick={() => setGenreFilter("")}
              className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-wider font-mono border transition-colors ${
                !genreFilter
                  ? "bg-amber-300 text-zinc-950 border-amber-300"
                  : "bg-transparent text-zinc-400 border-zinc-800 hover:border-zinc-600"
              }`}
            >
              todas
            </button>
            {allGenres.map((g) => (
              <button
                key={g}
                onClick={() => setGenreFilter(g === genreFilter ? "" : g)}
                className={`px-3 py-1 rounded-full text-[10px] uppercase tracking-wider font-mono border transition-colors ${
                  genreFilter === g
                    ? "bg-amber-300 text-zinc-950 border-amber-300"
                    : "bg-transparent text-zinc-400 border-zinc-800 hover:border-zinc-600"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Empty state */}
      {movies.length === 0 && status?.state !== "running" && (
        <div className="text-center py-20">
          <Film className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
          <p className="text-zinc-400 mb-4">Sin cartelera cargada</p>
          <Button
            onClick={handleRefresh}
            className="bg-amber-300 text-zinc-950 hover:bg-amber-200"
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Cargar cartelera
          </Button>
        </div>
      )}

      {/* Loading skeleton */}
      {movies.length === 0 && status?.state === "running" && (
        <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="aspect-[2/3]">
              <Skeleton className="w-full h-full rounded-lg" />
            </div>
          ))}
        </section>
      )}

      {/* Movies grid */}
      {view === "movies" && filteredMovies.length > 0 && (
        <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {filteredMovies.map((m) => (
            <MovieCard key={m.movie} movie={m} onClick={() => openMovie(m)} />
          ))}
        </section>
      )}

      {view === "movies" &&
        filteredMovies.length === 0 &&
        movies.length > 0 && (
          <div className="text-center py-20 text-zinc-500">
            Sin peliculas que coincidan con{" "}
            <span className="text-zinc-300">{`"${search}"`}</span>
          </div>
        )}

      {/* Cinemas grid */}
      {view === "cinemas" && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredCinemas.map((c) => (
            <Card
              key={c.cinema}
              className="bg-zinc-900/60 border-zinc-800 hover:border-amber-300/30 transition-colors"
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-bold text-zinc-100 text-sm leading-tight">
                    {c.cinema}
                  </h4>
                  <Building2 className="w-4 h-4 text-amber-300 flex-shrink-0" />
                </div>
                {c.address && (
                  <p className="text-xs text-zinc-400 mb-1 flex items-start gap-1.5">
                    <MapPin className="w-3 h-3 mt-0.5 flex-shrink-0 text-zinc-600" />
                    <span>
                      {c.address}
                      {c.city && (
                        <span className="text-zinc-500"> · {c.city}</span>
                      )}
                    </span>
                  </p>
                )}
                <div className="flex items-center gap-3 mt-3 pt-3 border-t border-zinc-800">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <span className="text-amber-300 font-bold font-mono">
                      {c.movies}
                    </span>{" "}
                    pelis
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    <span className="text-zinc-200 font-bold font-mono">
                      {c.functions}
                    </span>{" "}
                    funciones
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      {/* Footer */}
      <footer className="mt-16 pt-6 border-t border-zinc-900 flex flex-col md:flex-row items-center justify-between gap-3 text-[10px] uppercase tracking-widest text-zinc-600">
        <p>
          datos via la nacion · cartelera semanal · refresh automatico los
          jueves
        </p>
        <p>
          {movies.length} peliculas · {cinemas.length} cines ·{" "}
          {status?.totalRecords || 0} funciones
        </p>
      </footer>

      {/* Movie Detail Dialog */}
      <Dialog
        open={!!selectedMovie}
        onOpenChange={(open) => !open && setSelectedMovie(null)}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden bg-zinc-950 border-zinc-800">
          <DialogHeader>
            <DialogTitle className="text-zinc-100 text-lg font-bold">
              {selectedMovie?.movie}
            </DialogTitle>
          </DialogHeader>
          {!movieDetail ? (
            <div className="py-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-amber-300" />
            </div>
          ) : !movieDetail.found ? (
            <p className="text-zinc-500 py-4">No se encontraron detalles</p>
          ) : (
            <ScrollArea className="max-h-[70vh] pr-4">
              <div className="space-y-4">
                {/* Movie info */}
                <div className="flex gap-4">
                  {movieDetail.poster && (
                    <img
                      src={movieDetail.poster}
                      alt={movieDetail.movie}
                      className="w-24 h-36 object-cover rounded-lg flex-shrink-0"
                      crossOrigin="anonymous"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap gap-2 mb-2">
                      {movieDetail.genre && (
                        <Badge className="bg-amber-300/20 text-amber-300 border-amber-300/30 text-[10px]">
                          {movieDetail.genre}
                        </Badge>
                      )}
                      {movieDetail.duration && (
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-zinc-400 text-[10px]"
                        >
                          {movieDetail.duration}
                        </Badge>
                      )}
                      {movieDetail.classification && (
                        <Badge
                          variant="outline"
                          className="border-zinc-700 text-zinc-400 text-[10px]"
                        >
                          {movieDetail.classification}
                        </Badge>
                      )}
                    </div>
                    {movieDetail.synopsis && (
                      <p className="text-xs text-zinc-400 line-clamp-4">
                        {movieDetail.synopsis}
                      </p>
                    )}
                    <div className="flex items-center gap-3 mt-3 text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
                      <span>
                        <Building2 className="w-3 h-3 inline mr-1" />
                        {movieDetail.totalCinemas} cines
                      </span>
                      <span>
                        <Clock className="w-3 h-3 inline mr-1" />
                        {movieDetail.totalFunctions} funciones
                      </span>
                    </div>
                  </div>
                </div>

                {/* Cinemas list */}
                <div className="space-y-3">
                  <h4 className="text-xs uppercase tracking-widest text-zinc-500 font-mono">
                    Funciones por cine
                  </h4>
                  {movieDetail.cinemas.map((cinema) => (
                    <Collapsible key={cinema.cinema}>
                      <CollapsibleTrigger className="w-full p-3 rounded-lg bg-zinc-900/60 border border-zinc-800 hover:border-amber-300/30 transition-colors text-left">
                        <div className="flex items-center justify-between">
                          <div>
                            <h5 className="font-semibold text-zinc-100 text-sm">
                              {cinema.cinema}
                            </h5>
                            {cinema.address && (
                              <p className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                {cinema.address}
                                {cinema.city && ` · ${cinema.city}`}
                              </p>
                            )}
                          </div>
                          <ChevronDown className="w-4 h-4 text-zinc-500" />
                        </div>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <div className="mt-2 pl-3 space-y-2">
                          {cinema.formats.map((fmt) => (
                            <div key={fmt.format} className="flex flex-wrap gap-2 items-center">
                              <Badge className="bg-zinc-800 text-zinc-300 border-zinc-700 text-[9px] uppercase">
                                {fmt.format}
                              </Badge>
                              <div className="flex flex-wrap gap-1">
                                {fmt.showtimes.map((time, i) => (
                                  <span
                                    key={i}
                                    className="px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] font-mono text-amber-300"
                                  >
                                    {time}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>

                {/* Link to source */}
                {movieDetail.movieUrl && (
                  <a
                    href={movieDetail.movieUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-amber-300 hover:text-amber-200"
                  >
                    Ver en La Nacion <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
