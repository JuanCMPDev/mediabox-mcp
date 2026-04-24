import { Router, type Request, type Response } from "express";
import { getHealth }    from "../fetchers/health.js";
import { getSessions }  from "../fetchers/sessions.js";
import { getDownloads } from "../fetchers/downloads.js";
import { getLibrary }   from "../fetchers/library.js";
import { getServices }  from "../fetchers/services.js";
import { jfApi }        from "../helpers/api.js";
import { qbitApi }      from "../helpers/qbittorrent.js";

export const dashboardRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function wrap(fetcher: () => Promise<unknown>) {
  return async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await fetcher());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

function ok(res: Response) { res.json({ ok: true }); }

function fail(res: Response, err: unknown, status = 500) {
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
}

// ── Read endpoints ────────────────────────────────────────────────────────────

dashboardRouter.get("/health",    wrap(getHealth));
dashboardRouter.get("/sessions",  wrap(getSessions));
dashboardRouter.get("/downloads", wrap(getDownloads));
dashboardRouter.get("/library",   wrap(getLibrary));
dashboardRouter.get("/services",  wrap(getServices));

// ── Session admin actions ─────────────────────────────────────────────────────

/** Stop (kill) an active Jellyfin stream. */
dashboardRouter.post("/sessions/:id/stop", async (req, res) => {
  try {
    await jfApi(`/Sessions/${req.params.id}/Playing/Stop`, "POST");
    ok(res);
  } catch (err) { fail(res, err); }
});

/** Send an on-screen notification to a user via Jellyfin. */
dashboardRouter.post("/sessions/:id/message", async (req, res) => {
  const { header = "Admin", text } = (req.body ?? {}) as { header?: string; text?: string };
  if (!text) { fail(res, "text is required", 400); return; }
  try {
    await jfApi(`/Sessions/${req.params.id}/Message`, "POST", {
      Header: header,
      Text:   text,
      TimeoutMs: 5000,
    });
    ok(res);
  } catch (err) { fail(res, err); }
});

// ── qBittorrent download actions ──────────────────────────────────────────────
// Scope: qBit only. PyLoad package management via existing MCP tools (2.3+).

/** Pause a torrent. */
dashboardRouter.post("/downloads/qbit/:hash/pause", async (req, res) => {
  try {
    await qbitApi("torrents/pause", "POST", { hashes: req.params.hash });
    ok(res);
  } catch (err) { fail(res, err); }
});

/** Resume a paused torrent. */
dashboardRouter.post("/downloads/qbit/:hash/resume", async (req, res) => {
  try {
    await qbitApi("torrents/resume", "POST", { hashes: req.params.hash });
    ok(res);
  } catch (err) { fail(res, err); }
});

/** Delete a torrent. ?deleteFiles=true also removes downloaded data. */
dashboardRouter.delete("/downloads/qbit/:hash", async (req, res) => {
  const deleteFiles = req.query.deleteFiles === "true" ? "true" : "false";
  try {
    await qbitApi("torrents/delete", "POST", { hashes: req.params.hash, deleteFiles });
    ok(res);
  } catch (err) { fail(res, err); }
});
