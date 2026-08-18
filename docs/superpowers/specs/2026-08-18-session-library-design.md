# Scribe session library

Design doc, 2026-08-18.

## What it is

A browsable history of past recordings, opened from a hamburger in the top bar.
Every session appears with the date it was recorded as its title, renameable by
double-clicking. Sessions can be dragged under headings the user creates, and
dragged up and down to set their order within a heading.

Clicking a session loads its saved transcript and summary back into the two
existing panes, read-only. Right-clicking offers rename, move, and reveal in
Finder.

Any summary on screen, live or historical, can be copied to the clipboard as
chat-friendly plain text, saved as a Markdown file, or handed to the macOS share
sheet for Messages, Mail, or AirDrop.

## Why the organisation lives apart from the recordings

Session folders on disk remain the source of truth for what exists. A separate
`sessions/library.json` holds only what the user decided: category names, their
order, and each session's title, category, and position.

Two reasons to keep those apart. First, `meta.json` is a record of what the
machine did, written once at stop: duration, chunk count, cost. Titles and
categories are a different kind of fact and change often. Second, and more
practically, ordering is inherently global. A per-session file cannot express
"third under BUSI 520" without every sibling knowing about the others, so a
single drag would rewrite a dozen files. One index expresses it directly and a
drag becomes one small write.

The payoff is that the library file is disposable. Any session folder the file
does not mention appears under an implicit **Uncategorised** heading with its
date as its title, and any entry whose folder has vanished is ignored and pruned
on the next write. Losing the file loses names and grouping, never a recording.

## Rollback

The library file is a single point of failure for the user's organisation, so it
gets a restore point.

On server start, before serving any request, the current `library.json` is
copied to `sessions/.library-backups/rollback.json`. That snapshot is the state
of the library at the moment Scribe was opened, and it is what a restore returns
to. Before it is overwritten, the previous rollback is moved into
`sessions/.library-backups/archive/library-<ISO timestamp>.json`.

The archive keeps the most recent 30 snapshots and prunes older ones. Each file
is a few kilobytes, so this is generous; the cap exists only so a machine left
running for months does not accumulate without limit.

Restoring is offered in the sidebar footer as "Restore library to when Scribe
opened". It uses a two-step inline confirm, where the control relabels itself to
ask for confirmation and a second click commits, rather than a browser dialog.
Native dialogs block the page and are out of keeping with how the rest of this
app reports things. Before a restore is applied, the current `library.json` is
itself archived, so a restore can be undone by hand from the archive folder.

If no `library.json` exists yet, on a first run, there is nothing to roll back
to and the control is hidden.

**Known limitation, stated plainly.** The snapshot is taken at server start. If
Scribe is left running for a week, the restore point is a week old. Snapshotting
on a timer was considered and rejected as more machinery than a personal tool
needs, but the archive means intermediate states are recoverable by hand.

## Reading a session while recording

Clicking a history row while a recording is in progress does not open it. The
status line says "Stop recording to read past sessions" instead. Renaming and
reorganising stay available.

The reason is that the two panes are the only place text is displayed. Opening
an old session mid-recording would replace the live transcript on screen while
the microphone kept running, which reads as "the recording just broke" and
invites the user to hit stop to check. A lecture happens once, so that scare is
not worth building in.

**This restriction is temporary by explicit request and the design must not make
lifting it expensive.** Two requirements follow:

1. The panes render from an explicit view-mode value, either `live` or
   `session:<id>`, and take their data from a passed source object rather than
   reading module state directly. Adding a third mode later is then an addition,
   not a restructuring.
2. The check that blocks reading during recording lives in exactly one guard
   function. Lifting the restriction becomes that one change plus the new
   overlay UI, not a hunt through the view logic.

Reading a past session during a recording, which would need an overlay panel
above the summary pane so the live transcript stays visible underneath, is out
of scope for this version and planned for a later one.

## Data model

`sessions/library.json`:

```json
{
  "version": 1,
  "categories": [
    { "id": "cat_k3f9a2", "name": "BUSI 520", "order": 0 }
  ],
  "entries": {
    "2026-08-18-17-03-30": {
      "title": "Raft and distributed consensus",
      "categoryId": "cat_k3f9a2",
      "order": 0
    }
  }
}
```

`title` absent or empty means the session shows its date, derived from the folder
name rather than stored, so an unnamed session always shows its date and clearing
a name in the UI reverts to it. `categoryId` absent or unknown places the session
under Uncategorised.

Writes are atomic: the new content goes to a temp file in the same directory and
is then renamed over the target, so a crash mid-write leaves the previous file
intact rather than a truncated one.

There is no file locking, and no in-memory copy of the library either. Every
request that changes something reads `library.json` from disk, applies its
change to that value, and writes the whole file back. Nothing is cached between
requests, so the server can never serve a library that has drifted from what is
on disk, and an external edit to the file is picked up by the next request
rather than being overwritten from stale memory.

What this does not give is safety against two writes that overlap. A request
reads the file, and only later writes it back; another request that reads in
that window starts from the same value and writes second, so the first one's
change is gone. In practice that means a rename whose PATCH is still in flight
when a drag's PUT lands will lose one of the two. The window is a few
milliseconds of local file IO, one person is driving one browser tab, and the
cost of losing is one name or one row position, recoverable by doing it again
or by restoring the library. A write queue would close the window, and is not
worth the machinery at this size.

## Server surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/library` | The merged, grouped, ordered library |
| GET | `/api/sessions/:id` | Saved transcript, summary, and meta for reading |
| PATCH | `/api/sessions/:id` | Partial update of `title` and `categoryId` |
| POST | `/api/categories` | Create a heading |
| PATCH | `/api/categories/:id` | Rename or reorder a heading |
| DELETE | `/api/categories/:id` | Remove a heading |
| PUT | `/api/library/order` | Apply a completed drag as one atomic payload |
| POST | `/api/library/restore` | Restore from the rollback snapshot |
| POST | `/api/sessions/:id/reveal` | Open the session folder in Finder |

`GET /api/library` returns the result already merged with what is on disk and
already grouped and ordered, so the browser stays dumb and the ordering logic is
testable in Node.

Reordering is a single bulk endpoint rather than a series of per-row updates
because one drag can renumber several rows across two categories. Sending it as
one payload means the library cannot be left half-applied if a request fails
partway.

Deleting a category never deletes recordings. Its sessions fall back to
Uncategorised.

## The reveal endpoint is the one dangerous surface

Revealing a folder shells out to the operating system, which makes it the only
new place where user-controlled input reaches a command. Two rules, both
mandatory:

1. The session id is validated against a strict pattern before use. Anything
   containing a path separator, a `..`, or characters outside the known id shape
   is rejected with a 400. The resolved path is then confirmed to sit inside the
   sessions directory.
2. The command is invoked with `execFile("open", [dir])`, passing the path as an
   array element. The path is never interpolated into a shell string, so shell
   metacharacters have no meaning even if validation were somehow bypassed.

## Drag and drop

No npm package may enter browser code, so this is hand-rolled on the native
HTML5 drag events. That choice over pointer events is deliberate: the native
drag image comes free, the list is short, and this is a desktop tool driven by a
trackpad, so the touch support that pointer events would buy has no user here.
The usual native flicker, where `dragleave` fires when the cursor crosses a child
element, is handled by counting enter and leave depth per drop zone.

Drop targets are a thin insertion line between rows and the headings themselves,
which append to the end of that category.

**The insertion-index calculation is a separate pure function with its own
tests.** Given the pointer's y position and the bounding rectangles of the
visible rows, it returns the slot the drop lands in. That is where off-by-one
errors live, and it is the part a test can actually pin. This is a direct lesson
from the resampler defect found in the previous build, where the logic was
correct in isolation but wrong in the call pattern the tests never exercised.

Right-clicking a row opens a small menu with Rename, Move to category, and Reveal
in Finder. That menu is where the Finder option lives, and it doubles as the
escape hatch when a drag misfires.

## Interaction details

The sidebar is a left drawer toggled by a hamburger in the top bar, with its
open state remembered in `localStorage`. On a wide window it sits inline and
narrows the two panes. Below 900px it overlays them with a scrim so the
transcript is never squeezed into an unreadable column.

Renaming, for both sessions and headings, is a double-click that swaps the label
for an inline input seeded with the current text. Enter or blur commits, Escape
cancels, and an empty value reverts a session to its date default. One
interaction covers both, rather than two things to learn.

Edits apply optimistically and roll back on failure, with the reason in the
existing status line. That matches how the rest of the app reports problems and
avoids modals.

Headings render as muted grey per the existing Silver Gelatin palette and the
house design standard.

The currently recording session appears in the list as soon as its folder exists,
marked as live. It has no `meta.json` until stop, so it shows no duration.

## Getting a summary out of Scribe

Three controls sit in the summary pane's header: **Copy**, **Save**, and
**Share**. They act on whichever summary is currently displayed, so they work
for a past session being read and for a live recording once its first running
summary has arrived.

### One conversion feeds all three

Everything hangs off a single pure function that turns a summary into
chat-friendly plain text: headings become plain lines, list markers become real
bullet characters, and bold markers are stripped. The point is that a summary
pasted into WhatsApp or Messages should read like something a person wrote, not
like a file with `##` and `**` scattered through it.

It has to handle two different inputs. A running summary arrives as structured
data with topics, key points, definitions, flagged items, and open questions, so
its text is built directly from those fields. A final summary is Markdown
authored by Claude, so it is converted. Both paths end at the same plain text,
which is what makes one function worth having rather than three ad-hoc
stringifications.

This is a pure function with its own tests. It is small, it is easy to get
subtly wrong around nested lists and inline emphasis, and it is the kind of
thing that silently degrades without anyone noticing.

### Copy

Writes the plain text to the clipboard with `navigator.clipboard.writeText`.
Localhost counts as a secure context, so this works without a certificate.

If the write is refused, which can happen if the document is not focused or the
permission is denied, the failure is reported in the existing status line and
the summary text is selected in the DOM instead, so the user can press Cmd-C.
Failing to a state the user can rescue is better than failing to a message.

### Save

Downloads the summary as a Markdown file, built as a `Blob` and triggered
through an anchor with the `download` attribute. The filename comes from the
session's title, lowercased with spaces turned to hyphens and anything outside
letters, digits, hyphens and underscores removed, falling back to the session id
if the title sanitises down to nothing.

Note that the file already exists on disk at `sessions/<id>/summary.md`. Save
exists so the summary can leave the sessions directory as a normal file without
the user going hunting; Reveal in Finder covers the other case.

### Share

Opens the macOS share sheet through the Web Share API, so Messages, Mail,
AirDrop and anything else installed are all reachable without Scribe knowing
about any of them.

**The button only renders if the browser actually supports it.** Web Share
support in Chrome on macOS is not something this design assumes, so the control
is feature-detected at runtime rather than declared to work: if `navigator.share`
is absent the button is not shown at all, and Copy and Save cover the need. A
button that fails when pressed is worse than a button that was never there.

Where `navigator.canShare({ files })` reports support, the `.md` file itself is
shared, which is what makes AirDrop useful. Otherwise the plain text is shared
directly. The call must be made inside the click handler, since the API requires
a user gesture and will reject if it is called after an await.

A share cancelled by the user rejects with an `AbortError`, which is a normal
outcome and must not surface as an error. Only genuine failures reach the status
line.

### When there is no summary to give

Three cases, each handled honestly rather than with a dead button:

- A recording whose first running summary has not arrived yet. Controls are
  disabled with the reason shown, since the first one takes about five minutes.
- A session whose final summary failed, which is not hypothetical: it happened
  during this project's own verification when the model was overloaded, leaving
  a session with a transcript and no `summary.md`. The controls fall back to the
  last running summary if one was captured, and if none was, they are disabled
  and say the summary failed rather than pretending the session has none.
- A session that has a summary file but it is empty. Treated the same as a
  failed summary.

## Testing

Server side, where the logic is:

- Merging on-disk folders with library entries: unknown folders land in
  Uncategorised, entries for missing folders are ignored and pruned.
- Default title derivation from a session id.
- Applying a reorder payload, including moving a session between categories.
- Deleting a category reassigns its sessions and touches no session folder.
- Atomic write: a simulated failure mid-write leaves the previous file intact.
- Rollback: a snapshot is taken at start, the previous one is archived, the
  archive prunes at 30, and restore reinstates the snapshot after archiving the
  current file.
- Reveal path validation rejects ids containing `..`, a slash, or anything
  outside the id shape, and rejects a resolved path outside the sessions
  directory.

Browser side:

- The insertion-index function, tested against realistic row rectangles
  including the first slot, the last slot, and an empty category.
- The plain-text conversion, from both input shapes: a structured running
  summary, and Claude-authored Markdown containing headings, nested lists,
  inline bold, and a definitions list. Includes the empty-summary case and a
  summary containing only one populated section, since a thin lecture produces a
  mostly empty structure and the output should not be a run of blank headings.
- The filename sanitiser, including a title that reduces to nothing and must
  fall back to the session id.
- Clipboard, download, and share wiring is verified by hand, as with the capture
  pipeline, for the same reason: no usable test double exists and mocking it
  would test the mock.

## Files

```
src/server/library.ts         load, save, merge, mutate, atomic write, rollback
src/server/library-routes.ts  the routes above, as an Express router
src/web/history.js            sidebar rendering, rename, context menu
src/web/dnd.js                insertion-index maths and drag wiring
src/web/summary-export.js     plain-text conversion, copy, save, share
tests/library.test.ts
tests/dnd.test.js
tests/summary-export.test.js
```

Routes go in their own module rather than into `src/server/index.ts`, which is
about a hundred lines today and would roughly double with nine more routes in
it. Things that change together stay together.

## Out of scope

Reading a past session while recording, which needs an overlay and is planned
next. Deleting sessions from the UI. Search across transcripts. Nesting
categories. Sync across machines.

Sharing the transcript, as opposed to the summary. The transcript is long, ASR
output reads poorly out of context, and the summary is what a person actually
wants sent to them. Reveal in Finder reaches the transcript file for the rare
case.

Writing both Markdown and formatted HTML to the clipboard at once, so that notes
apps receive real formatting while chat apps receive readable text. It is the
better answer eventually, but it needs a hand-written Markdown to HTML converter
because no npm package may enter browser code, and that is more surface than
this version should carry.

Exporting to PDF. The browser's own print-to-PDF already covers it.
