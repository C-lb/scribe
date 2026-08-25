/**
 * The one place anything on this page is allowed to raise an alarm.
 *
 * Scribe's status line is a note, not an alarm: it is one ellipsised span in a
 * crowded header bar, and it is where "3 chunks waiting to upload" lives. That
 * is the right register for housekeeping and the wrong one for "your mic is
 * dead and the lecture is not being recorded". So problems the user can act on
 * get their own region, above the panes, where a sentence has room to say what
 * to do about it.
 *
 * Three severities, and no more, because each one has to earn a different
 * reaction:
 *   info    something normal happened that explains a gap. No action.
 *   warn    something is probably wrong and is probably fixable right now.
 *   danger  capture is broken. Nothing is being transcribed until it is fixed.
 *
 * Colour is the semantic set from styles.css and carries meaning only, never
 * decoration. A banner always says what to DO, not just what happened, which is
 * the difference between error reporting and error proofing.
 */
export function createBanner({ root }) {
  let current = null;

  function clear() {
    current = null;
    root.replaceChildren();
    root.hidden = true;
  }

  return {
    /**
     * @param severity  "info" | "warn" | "danger"
     * @param message   what is wrong, in one plain sentence.
     * @param action    optional { label, onClick } for the corrective step.
     * @param detail    optional second line: where things stand, so the user
     *                  knows what has and has not been lost.
     * @param key       identity. Re-showing the same key is a no-op, so a
     *                  condition that re-fires every chunk does not rebuild the
     *                  banner under the user's cursor mid-click.
     */
    show({ severity = "info", message, action, detail, key } = {}) {
      const identity = key ?? `${severity}:${message}`;
      if (current === identity) return;
      current = identity;

      const box = document.createElement("div");
      box.className = `banner banner--${severity}`;
      // Assertive only for danger: an aria-live region that interrupts on every
      // pause in a lecture would make a screen reader unusable.
      box.setAttribute("role", severity === "danger" ? "alert" : "status");

      const text = document.createElement("div");
      text.className = "banner__text";

      const line = document.createElement("p");
      line.className = "banner__message";
      line.textContent = message;
      text.append(line);

      if (detail) {
        const sub = document.createElement("p");
        sub.className = "banner__detail";
        sub.textContent = detail;
        text.append(sub);
      }

      box.append(text);

      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "banner__action";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          try {
            action.onClick();
          } catch (error) {
            // A failing corrective action must not leave a dead button and no
            // explanation; the caller's own error path shows the next banner.
            console.error("[scribe] banner action failed", error);
          }
        });
        box.append(button);
      }

      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "banner__dismiss";
      dismiss.setAttribute("aria-label", "Dismiss");
      dismiss.title = "Dismiss";
      // Feather "x", matching the hamburger already in the header bar: same
      // family, same 2px stroke, same round caps. Never a glyph or a webfont.
      dismiss.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" /></svg>';
      dismiss.addEventListener("click", clear);
      box.append(dismiss);

      root.replaceChildren(box);
      root.hidden = false;
    },

    clear,

    /** Clear, but only if the banner on screen is still the one named. Lets a
     *  condition retract its own message without wiping a worse one that
     *  arrived after it. */
    clearIf(key) {
      if (current === key) clear();
    },

    get showing() {
      return current;
    },
  };
}
