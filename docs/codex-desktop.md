# Shared Codex Desktop conversations

On web and desktop, choose **Connect a Codex Desktop conversation** in the sidebar. The connection
page keeps your normal project and thread sidebar visible. Select the Windows
host, then an existing Desktop conversation. It opens in T3's normal chat view
with a **Shared** marker. Keep Codex Desktop running
on that host. Enabling the shared provider requires provider-management access;
binding and sending require orchestration-operation access.

New project and draft controls offer **T3 owned** and **Codex shared**. A project
default applies to new drafts; each created conversation keeps its own type.
Changing the project default does not migrate existing conversations. The Shared
marker identifies participation in synchronization; the connection status still
determines whether messages can be sent. New shared drafts use **Codex Desktop
Share**. Send the first message in T3, wait for release, then use **Open in Codex
Desktop** and **Connect to Desktop** on the same conversation. Existing shared
chats keep their provider and account until an explicit handoff.
If the shared provider is absent, enable it from the shared draft controls first.
The server enforces this provider choice for creation, queued starts and retries.
An unbound draft using another provider stays intact but cannot create a shared chat.

T3 owned means T3 manages the conversation's execution. Codex can still list its
saved history. This choice does not isolate Codex history files from other clients.

Before handoff T3 owns a native Codex process and reads saved history. After
handoff the same provider follows the Desktop owner over IPC. These execution
sessions are isolated; a disconnected follower never falls back to another writer.
Imported messages are stored in T3's normal
thread projections, so existing shell subscriptions, detail subscriptions, HTTP
snapshots and history APIs can consume them. Existing shared chats passed history,
text sending and Desktop-origin updates in the native Android client on MuMu.
Use web or desktop for the shared connection directory, catalog-source explanation
and title synchronization status. Physical-phone and iOS acceptance remain pending.

Text, model and effort choices use the normal T3 send path. Attachments use T3's
existing input builder. A text-file upload was read successfully by the shared
owner; image and other document formats still need end-to-end acceptance.
The displayed effort follows the owner's current thread settings, with the older
reasoning field used only when that setting is absent. An explicit default clears
the saved selection; a missing field preserves it.
Desktop-origin messages and responses are projected back into the same thread.
T3 queues its own sends while the native turn is busy. A simultaneous Desktop
start can win the race; T3 reports a rejected or uncertain send instead of
replacing the owner's queue. Queue entries and executing turns remain separate.

The model picker labels the Desktop catalog as unavailable. Candidates use this host's configured Codex discovery and catalog, not a
live model list from the Desktop owner. Its version, account, cache and custom
models can differ from Desktop. A same-version read-only discovery probe is
possible without loading a conversation; matching those candidates does not
verify every model against Desktop's current account. Select a missing model in
Desktop and let its current selection sync back.

After handoff, execution permissions and workspace remain controlled by Desktop. Importing a
conversation never grants full access. T3 permission defaults are removed from
forwarded requests, and the owner resolves its current policy. Change execution
permissions in Desktop. Shared threads cannot switch to an independent writer.

A saved or draft shared model missing from T3 candidates remains selected with its raw
options. Sending is blocked until candidates include it again or you explicitly select
a model. Missing entries cannot be selected through the picker or composer shortcuts.
This guards new composer submissions; already queued runs retain their existing execution rules.
Catalog loss never silently selects another model. This does not verify the
Desktop account entitlement of a listed candidate.

## Current limits

- The unified entry uses Desktop's verified Codex home. Managed accounts, auth
  overlays and per-process account/profile overrides require a separate provider;
  they cannot create a native chat through this fixed shared identity.
- While T3 owns the native conversation, release prepares the latest manual or generated
  title in Codex history. If the title changes after release, use **Check release** before
  opening Desktop. Preparation waits for an active title generator and preserves an observed
  external rename as a conflict. On Windows it supports a directly configured absolute
  `codex.exe`, and the verified official npm `0.167.1` Windows x64 launcher with its
  matching native package. T3 preserves the npm managed-package environment without
  changing provider settings. Unknown versions, wrappers, redirected package paths,
  Node startup overrides and custom app-server arguments keep their original launch
  behavior and do not qualify for title preparation. It requires a verified process identity;
  unsupported hosts or an initial read failure leave the title unsaved and allow release.
  The protocol has no compare-and-set rename: a concurrent external metadata writer can
  still race the read and write. This does not establish full bidirectional title synchronization.
- A title write with an unknown outcome blocks handoff and is never automatically resent.
  A matching read alone does not clear it. After the original T3 Codex process exits, **Check release**
  can verify its absence on the same Windows host and reconcile the saved name, preserving
  any difference as a conflict. A live/reused PID, inaccessible process or unknown host keeps
  the operation unconfirmed. T3 does not terminate a process to resolve a title.
- Once Desktop owns the conversation, automatic title writes to Desktop remain unavailable.
  The title status confirms only a matching nonempty title
  observed from the live Desktop owner. Conflicting edits keep the T3 name and
  show the Desktop name. Rename either side to match, then wait for the next owner
  update. A native name write or a display fallback is not Desktop confirmation.
- New native conversations synchronize saved text until handoff. Keep the chat
  idle with no pending tools or approvals before connecting. Native handoff with
  input attachments, steering inputs or app-tool inputs is not yet supported.
- Active steering is disabled: follower steer v1 cannot atomically carry T3's
  expected-turn guard. Stop uses the native guarded interrupt operation.
- Command and permission approvals and structured questions use T3's normal
  request cards. Structured question replies have passed a live Desktop round trip.
  Approval forwarding has isolated regression coverage; live approval acceptance
  is pending. Review the requested action and scope before responding.
  File-change approvals remain in Desktop; recorded file diffs do not establish
  the complete contents and scope of a pending approval request.
  Other unsupported request types remain available in Desktop. Start compaction
  in Desktop; T3 displays actual native compaction progress and completion. The
  follower operation returns no turn ID or request correlation and has no atomic
  idle guard, so T3 cannot safely claim the next observed compaction as its own.
  Desktop's optimistic placeholder is not a completed or accepted execution.
  Context reset, goal controls, rollback, forks and subagents are not enabled.
- This preview projects messages, reasoning, command execution, compaction,
  file changes and plans. Each recorded file has its own diff, including move
  destinations. Missing or binary diffs remain unavailable. A path removed from
  Desktop's patch is marked cancelled; its earlier diff is withdrawn.
  New todo versions supersede earlier versions. A completed proposal remains a
  proposal, and unfinished plans retain their state after a failed or interrupted
  turn. Display depends on the native artifacts provided by the Desktop runtime.
  Other provider artifacts still need full mapping and acceptance.
- CLI and IDE records may appear in the list because they share local storage.
  Sending requires a compatible Desktop owner; a shared file does not establish
  a shared execution process.

`CODEX_HOME` selects the host's Codex store. The read-only connection directory searches
all indexed ages and Desktop project assignments, with 100 records per page and an
active/archived filter. Refresh to include chats updated while paging; reaching the
last page is not a frozen inventory. Chats absent from a page are never deleted from T3.
The directory depends on Codex's state index and does not scan or repair unindexed rollouts.

**Complete saved history** uses Codex's read-only history APIs to load every turn and
item page, including tool records, attachment references and future item fields.
Discovery combines the native API with the read-only local index, covers active and
archived chats of every age, and retains known IDs when a discovery source fails.
The native reader handles compressed and inherited history. It never resumes a chat
or starts a model turn. Two matching complete observations are required before a
snapshot replaces the current saved version; this detects concurrent changes but
is not an atomic native snapshot.

Enable **Codex Desktop Share** to start caching. The sidebar shows discovery and cache
progress. Chats with an existing workspace appear in the normal chat view; its
**Complete saved history** dialog includes records beyond the completed text timeline.
Chats without a workspace and attached histories remain readable in the saved-history
list. Internal subagents and ambient executions are excluded. Desktop project membership
is shown separately from the execution directory, with explicit **No project** and
**Project unknown** groups. Moving a chat between Desktop projects does not rewrite its
execution workspace. An existing unverified T3 owner keeps its original binding;
connecting its verified Desktop owner associates the saved history with that same row.

History is stored in T3's private `codex-desktop-history.sqlite`, scoped to the verified
physical Codex home. Saved pages retain their snapshot while newer versions arrive.
A missing page shows an error and keeps the last loaded page. Failed reads, restarts,
unavailable source directories and native rewinds preserve earlier saved versions.
The sidebar reports cache size and retained versions. This release retains all versions;
long, frequently changing chats can use substantial disk space. It does not automatically
prune native records or the cache. Cache write failures preserve the last complete
snapshot and report the failure.

Background caching is eventual: discovery runs each minute and a fair queue processes
up to ten candidates per cycle. A loaded Desktop owner supplies live IPC updates to
connected chats. Enablement, provider configuration and physical source are rechecked
before publication and sending. Disabling or changing Share stops the old follower and
rejects new sends without interrupting a turn executing in Desktop. Restore the verified
source and reconnect to continue. Pages remain readable from the last verified cache.
Source verification compares configuration and the resolved home path. Replacing an
account or directory contents at the same path is not an independently verified identity
change; restart and reconnect after such a replacement.

New shared bindings use the fixed Desktop Share provider. Pre-release shared bindings
using other providers remain read-only with their records and native IDs preserved.
Ordinary T3-owned conversations retain their existing behavior. The legacy project
importer never creates fresh shared bindings from arbitrary providers.

## Recovery

Viewed shared chats follow saved native titles through two matching metadata-only
`thread/read` calls. Each active chat reads again 30 seconds after its previous
attempt; all chats share one reader slot, with at least five seconds between starts.
Multiple viewers share a worker. Closing the last subscription cancels it and waits
for cleanup. Disabling Share or changing its verified source cancels an active read.
Reads time out after ten seconds and never start a model turn.

The private cache keeps a separate title epoch and revision. These reads do not
replace full history, refresh its timestamp, or move a chat's activity timestamp.
T3 can follow successive saved names while Desktop still displays an older title.
The title status distinguishes that saved name from a confirmed live owner title.
Pending local writes, uncertain outcomes, generation and ambiguous old names retain
the local title. A matching saved baseline can recover after a cache restart or a
temporary guard; only a live owner observation confirms Desktop's displayed name.
Read-side adoption never schedules `thread/name/set`, including during later native
release preparation and recovery. New manual/generated title intents use the normal
native preparation path. Full owner model discovery and automatic title write-back
to a running Desktop owner remain separate follow-up work.

Release, connection validation and the Open/Connect buttons share the same title
handoff rule. An older successful native write does not block a newer read-side
observation. Unconfirmed writes still block handoff, and a new local title must
pass preparation. The connection commit also checks the current title and intent
version, so a late local edit cannot be overwritten by the prepared handoff.

The reader limit applies to title metadata; full-history caching runs independently.
Each successful title poll advances its private revision. A thread metadata event
is appended only when title semantics change: the name, source/epoch, baseline or
protection state, local intent, or owner confirmation. The last published revision
may therefore lag behind the private watermark; publication checks the latest
private observation before comparing semantics so a stale read cannot become a
new change. Historical events are retained. Synthetic fixture process timings measure
the external test driver, not product reader process count, peak concurrency or cost.
The delivery report distinguishes those timings from measured product observations
and stored event payload growth; physical database growth includes other overhead.

Full-history reprojection retains the current chat activity time across restarts,
cache refreshes and older backfill. Completed native turn/message timestamps can
advance it, while newer local actions remain the floor. The batch finishes with
thread metadata so provider bookkeeping cannot replace that activity time.

Desktop-owned chats show the owner's current sandbox and approval policy. Messages
inherit that policy; change it in Codex Desktop. A disconnected or unavailable
owner shows an unavailable permission status. Structured permission approvals show
the complete file/network grant, with separate turn and session duration choices.

T3-owned shared chats request immediate idle unloading after unsubscribe, avoiding
Codex's default 60-second retention before Desktop can take over. Release still
requires no protected work, a successful unsubscribe and confirmation that the
native thread has closed and is no longer loaded. Ordinary Codex chats keep their
normal unload configuration.

The follower validates owner, conversation, stream version and revision. A gap
loads a fresh snapshot. The importer waits for complete history before assigning
persisted order, and preserves identities across shorter windows and reconnects.
An existing native conversation already managed by T3 cannot be imported twice.
Import checks skip a native ID already tracked by another provider and
record an ambiguous-home warning. They keep the existing provider and history;
current provider settings are not treated as proof of an older chat's storage
identity. Explicitly reconcile the existing conversation before importing a copy.

A send is reserved durably before it is forwarded. A known acknowledgement is
reused; an uncertain result is never automatically resent. A definite pre-send
rejection clears its pending identity. After a process crash, pending submissions
become uncertain. Trusted client-ID or acknowledgement correlation resolves them.
Until then, new identities wait for review rather than being guessed.

If a send fails with an unknown result, inspect Desktop and reconnect that conversation
from the connection page. If you confirmed that the input was not sent, use the explicit
confirmed-unsent action. It clears the identity warning while retaining the
no-replay delivery record. Known turns can continue updating during review.

Responses are also reserved across reconnects and restarts. An uncertain reply is
not sent again. The request remains pending until Desktop closes it; question
answers are displayed from Desktop's canonical result. A forwarding receipt alone
does not establish that this client's answer won a race with the other client.

## Development

Use the Node and pnpm versions pinned by the repository. Explicitly set
`T3CODE_HOME` to this checkout's `.t3` and `T3CODE_DEV_SEED=0`. Avoid multiple
`dev-electron.mjs` watchers for the same checkout: they can restart overlapping
Desktop instances when the server bundle changes. Never run acceptance against
the installed user's T3 home.

The transport was inspected on Windows Desktop `26.1106.6628.0`, stream v11,
start v2 and interrupt v4. Recheck after Desktop upgrades. The native-chat
integration has passed ordinary T3 UI sending, terminal-state completion, owner
input synchronization, model/effort checks, structured question replies and page
reload recovery. A real T3 → Desktop → T3 conversation also preserved its native
identity and context across three turns and a restart. Structured approval content
and responses have synthetic coverage; real approval and mobile functional
acceptance remain pending. See [fork operation and acceptance](operations/codex-desktop-fork.md)
for portable operating instructions, acceptance boundaries and upstream maintenance.
