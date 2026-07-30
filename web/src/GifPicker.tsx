import { useEffect, useRef, useState } from "react";
import { Gif, searchGifs, trendingGifs } from "./api";

export function GifPicker({
  baseUrl,
  token,
  onSelect,
}: {
  baseUrl: string;
  token: string;
  onSelect: (gif: Gif) => void;
}) {
  const [search, setSearch] = useState("");
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    trendingGifs(baseUrl, token)
      .then(setGifs)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!search.trim()) {
      setLoading(true);
      trendingGifs(baseUrl, token)
        .then(setGifs)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
      return;
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true);
      setError(null);
      searchGifs(baseUrl, token, search)
        .then(setGifs)
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 350);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  return (
    <div className="picker-panel">
      <input
        className="picker-search"
        placeholder="Search GIFs"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />
      <div className="gif-grid">
        {loading && <p className="picker-empty">Loading…</p>}
        {!loading && error && <p className="error">{error}</p>}
        {!loading &&
          !error &&
          gifs.map((gif) => (
            <button key={gif.id} type="button" className="gif-thumb" onClick={() => onSelect(gif)}>
              <img src={gif.previewUrl} alt={gif.title} loading="lazy" />
            </button>
          ))}
        {!loading && !error && gifs.length === 0 && <p className="picker-empty">No results</p>}
      </div>
      <p className="picker-attribution">Powered by GIPHY</p>
    </div>
  );
}
