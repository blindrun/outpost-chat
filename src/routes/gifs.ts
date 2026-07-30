import type { FastifyInstance } from "fastify";
import { z } from "zod";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

const searchSchema = z.object({
  q: z.string().min(1).max(100),
});

interface GiphyImage {
  images: {
    fixed_width_small: { url: string };
    original: { url: string };
  };
  id: string;
  title: string;
}

function simplify(gifs: GiphyImage[]) {
  return gifs.map((gif) => ({
    id: gif.id,
    title: gif.title,
    previewUrl: gif.images.fixed_width_small.url,
    url: gif.images.original.url,
  }));
}

export async function gifRoutes(app: FastifyInstance) {
  app.addHook("onRequest", app.authenticate);

  // GIF search is an optional feature — GIPHY_API_KEY is a per-instance
  // secret an admin has to provision themselves (see deploy/README.md), so
  // any instance without one configured just doesn't offer it. 501 lets the
  // client distinguish "not set up here" from a real provider error.
  app.get("/gifs/search", async (req, reply) => {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return reply.status(501).send({ error: "GIF search is not configured on this instance" });

    const { q } = searchSchema.parse(req.query);
    const res = await fetch(
      `${GIPHY_BASE}/search?api_key=${apiKey}&q=${encodeURIComponent(q)}&limit=24&rating=pg-13`,
    );
    if (!res.ok) return reply.status(502).send({ error: "GIF provider request failed" });
    const data = (await res.json()) as { data: GiphyImage[] };
    return simplify(data.data);
  });

  app.get("/gifs/trending", async (_req, reply) => {
    const apiKey = process.env.GIPHY_API_KEY;
    if (!apiKey) return reply.status(501).send({ error: "GIF search is not configured on this instance" });

    const res = await fetch(`${GIPHY_BASE}/trending?api_key=${apiKey}&limit=24&rating=pg-13`);
    if (!res.ok) return reply.status(502).send({ error: "GIF provider request failed" });
    const data = (await res.json()) as { data: GiphyImage[] };
    return simplify(data.data);
  });
}
