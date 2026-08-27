import type { RequestHandler } from "express";

/**
 * Scribe has no authentication: it binds 127.0.0.1 and trusts whoever is at
 * the keyboard. That is fine for a request the user's own page makes, and not
 * fine for one another site makes on their behalf. Several of these routes
 * take no body at all (POST /api/sessions/:id/stop, POST /api/sessions/:id/
 * reveal), which makes them CORS-simple: any page in any other tab can
 * `fetch(..., { mode: "no-cors" })` them and the browser will send the
 * request even though it refuses to show the response. Session ids are
 * guessable timestamps, so "they cannot read the answer" is no comfort when
 * the effect is stopping a lecture that is still being recorded or popping
 * Finder windows.
 *
 * One check, mounted once in createApp() ahead of every router, rather than a
 * gate per route: a route added later is covered by default, which is the
 * failure mode that matters.
 *
 * `Sec-Fetch-Site` is the primary signal because the browser sets it and a
 * page cannot forge it. Where it is absent the check falls back to `Origin`,
 * and a request with neither is allowed through: that is a non-browser caller
 * (curl, a test's own fetch), which was never subject to the browser's
 * ambient-authority problem in the first place.
 */
export function sameOriginOnly(): RequestHandler {
  return (req, res, next) => {
    // Reads cannot change anything, and blocking them would break the static
    // page and the audio element for no gain.
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();

    const site = req.get("Sec-Fetch-Site");
    if (site) {
      // "none" is a user-initiated navigation (typing the URL, a bookmark).
      if (site === "same-origin" || site === "none") return next();
      return res.status(403).json({ error: "cross-site request refused" });
    }

    const origin = req.get("Origin");
    if (!origin) return next();

    try {
      if (new URL(origin).host === req.headers.host) return next();
    } catch {
      // An unparseable Origin is not a same-origin one.
    }
    return res.status(403).json({ error: "cross-site request refused" });
  };
}
