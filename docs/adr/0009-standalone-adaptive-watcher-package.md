# Package the hybrid watcher as a standalone adaptive watcher

**Status: accepted.**

**Context.** Obelisk needs low-latency indexing of agent transcripts without
making filesystem notifications the source of truth. No single native watcher
primitive provides the required behaviour at acceptable cost. On macOS,
`@parcel/watcher` uses one recursive FSEvents subscription per tree and avoids
the descriptor exhaustion seen with chokidar 4, but a real Codex transcript
that was opened before subscription and then appended through a long-lived file
descriptor produced no event until that descriptor closed. A minimized probe
reproduced the same result with Parcel/FSEvents and Node directory `fs.watch`;
file-level `fs.watch(file)` and Parcel's kqueue backend reported the append
immediately. Full-tree kqueue is not acceptable because Parcel recursively
opens every entry with `O_EVTONLY`, returning to an `O(all paths)` descriptor
model. Provider watch declarations also currently mix directory trees with
exact files such as `history.jsonl` and `session_index.jsonl`, even though
Parcel subscriptions require a directory. The evidence and backend comparison
are recorded in
[`docs/watcher-backend-options-research.md`](../watcher-backend-options-research.md).

**Decision.** Build the hybrid watcher as a standalone workspace package with
a public-quality interface, dogfood it in Obelisk, and publish it only after the
interface and cross-platform behaviour are proven. It is an **adaptive
watcher**, not a chokidar-compatible watcher and not a promise that every tree
event is delivered.

The package interface distinguishes target semantics explicitly:

```ts
type WatchTarget =
  | { kind: 'tree'; path: string }
  | { kind: 'file'; path: string };

type WatchInvalidation =
  | { type: 'paths'; paths: string[] }
  | { type: 'rescan'; roots: string[]; reason: string };
```

Callers create a watcher with targets, an optional initial hot-file set, a hard
hot-file limit, a polling interval, and an invalidation callback. The remaining
dynamic interface is deliberately small: promote a path into the hot set and
close the watcher. Platform selection, retry, root recovery, deduplication,
replacement detection, bounded polling, timer cleanup, and subscription
lifecycle remain implementation details of the package.

- `tree` targets use `@parcel/watcher`'s native recursive backend to observe
  topology changes and ordinary updates with resource use proportional to
  configured roots rather than total files.
- `file` targets are pinned in a small asynchronous metadata poller and are
  never passed to Parcel as subscription roots.
- Recently active transcript paths occupy a bounded LRU hot set. The first
  implementation polls at approximately one-second intervals with limited
  concurrency and compares at least `{ dev, ino, size, mtimeMs }`. Only one
  poll tick may be in flight. No synchronous filesystem calls run on the
  Electron main thread.
- Native events may promote paths into the hot set; an initial/full inventory
  may seed existing active paths so a file opened before watcher startup is
  covered.
- Known watcher loss, overflow, or root restoration emits `rescan` rather than
  pretending that a precise path list is complete.

**Hot-set closure and degradation.** The implementation must preserve an
explicit path into the hot set for both startup and runtime activity:

1. A startup/full inventory returns `watchHints` for recently processed
   transcripts, covering an active file whose descriptor was already open
   before the watcher started.
2. A new transcript is first visible as a topology `create` event on its tree.
   The package promotes that path before delivering the path invalidation; the
   caller's catch-up build reads all content written before promotion, and
   polling covers later appends.
3. A native path event or polling hit promotes or refreshes the path's LRU
   position. Pinned `file` targets are never evicted; non-pinned transcripts
   remain subject to the hard hot-set bound.
4. A paused transcript may be evicted after enough newer transcripts displace
   it. If its still-open descriptor later resumes appending without a native
   event, low-latency detection is no longer guaranteed: the next full
   reconcile discovers the changed cursor, rebuilds it, and seeds it back into
   the hot set. This is the deliberate degradation boundary that keeps resource
   use bounded.

The package makes two different guarantees explicit. Changes to pinned and hot
files are detected within the configured polling window, subject to filesystem
access. Recursive tree events remain best-effort. Final consistency is owned by
the caller: Obelisk keeps its periodic full-inventory reconcile and routes both
native and polled path invalidations through the existing changed-path debounce
and incremental cursor machinery. The package does not learn Obelisk providers,
open databases, or trigger index builds.

**Platform policy.** The first version uses Parcel for `tree` targets on every
supported platform and polls explicit `file` targets on every platform, because
passing a file to a recursive directory backend is invalid regardless of OS.
The bounded hot-transcript polling overlay is enabled on macOS first, where the
long-lived-open-file failure is reproduced. Linux and Windows keep their native
Parcel update path until the same long-lived writer matrix demonstrates a need
for the overlay; enabling it there is a later measured decision, not the
default. Obelisk retains full reconcile on every platform.

**Rejected alternatives.** A full-tree kqueue watcher and chokidar's per-path
model restore real-time append notification but repeat the descriptor failure
that motivated this work. Pure Parcel/FSEvents misses the verified long-lived
append workload. Full-tree polling makes I/O scale with the complete corpus.
Watchman improves recrawl and cursor recovery but does not create a new macOS
notification primitive; its hybrid mode does not cover arbitrary deep open
transcripts. Rust `notify` and watchexec select among the same FSEvents,
kqueue, and polling trade-offs while adding a sidecar build, signing, and
lifecycle surface. A custom native daemon is deferred until measurement proves
bounded asynchronous polling inadequate.

**Verification before publication.** The package must be tested with writers
that open files both before and after subscription, append repeatedly without
closing, replace files at the same path, delete and recreate roots, and inject
overflow/error recovery. The matrix must cover macOS APFS, Linux inotify,
Windows NTFS with buffered writes, and supported WSL/network paths. Acceptance
requires bounded hot-set size, no poll overlap or shutdown leaks, no descriptor
growth proportional to a roughly 23k-path corpus, and an Obelisk full reconcile
that converges source cursors after deliberately dropped notifications. For a
pinned or resident hot transcript on macOS, the initial end-to-end target is
`p95 <= 4 s` from a completed source append to the corresponding update being
visible in the renderer. This includes the approximately one-second polling
window, the current two-second debounce plus 500 ms stability wait, worker and
database time, and renderer notification. Issue #86 may later replace the
unbounded debounce and tighten this target; this ADR does not pre-decide that
scheduling change.

**Consequences.** This is a coordinated Core + app migration, not an app-local
watcher substitution. Changing `watchRoots(): string[]` to typed watch targets
touches the provider adapter contract, every built-in provider, the provider
registry and settings-derived roots, their contract tests and documentation,
and every app/daemon consumer of the registry. Obelisk's inventory/build result
also needs a narrow way to supply hot-file hints. The package extraction and
contract migration must be implemented in follow-up issue(s) and PR(s), rather
than further expanding PR #83.

The first implementation lives in this monorepo so its interface can change
while the real workload teaches us; npm publication is a later decision, not a
requirement for Obelisk adoption. Other applications can reuse the package when
they can identify a bounded important working set and accept the same honest
consistency contract.
