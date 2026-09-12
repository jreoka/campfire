# Campfire test catalogue

The per-test detail behind **Verification conventions** in `AGENTS.md`. One
entry per `scripts/test-*.js`: what it actually asserts, what it silently
skips on (Postgres / Chrome / ffmpeg / a fake camera), and which source files
you should re-run it after.

It is kept out of `AGENTS.md` on purpose: that file is auto-loaded into every
session under a byte budget, and this catalogue is roughly 40 KB of it.

- **Tests:** `node scripts/test-unfurl.js [--live]` covers the link-preview parser
  and the SSRF guard (offline by default; `--live` also fetches real pages and
  proves a 302 to a link-local address is refused).
  `node scripts/test-friends-voice.js` covers the Active Now IN VOICE rail
  against a throwaway database: the friend-scoped `friends-voice` push, joinable
  rooms carrying server/channel vs nameless unreachable ones, invisible friends
  hidden, DM calls visible only to thread members, and the map following
  join/leave/mod-disconnect/channel-delete/server-eviction.
  `node scripts/test-stories.js` covers stories end-to-end against the dev
  server (audiences, view receipts, delete, 24h reaper) and restarts the dev
  server for the boot-reaper check. It expects the dev Postgres and a
  `JWT_SECRET`-equivalent `.env` (see Running it).
  `node scripts/test-story-reactions.js` covers story quick reactions against a
  throwaway database: the client's emoji set and repeat cap match the server's,
  the same emoji can be tapped up to 4 times (each tap adds a copy) and a tap at
  the cap takes that whole set back, different emojis stack independently, the
  author's own item never offers a reaction while each viewer row lists the
  emojis they sent and how many, reacting also records the view,
  auth/audience/blacklist/emoji validation, and the live `story-reaction` push
  (full tally + view count) reaching the audience only. The static half always
  runs; the API half skips without Postgres.
  `node scripts/test-story-reactions-browser.js` drives the real rail (the
  sliced `svRenderReactions`/`svReact`/`svFloatEmoji`/`svStartReactionBurst`)
  in headless Chrome against the real `#story-view` markup + stylesheet: the
  buttons light and badge their count, a tap ticks and floats a copy out of the
  button (real keyframes, anchored at the button, self-removing on animationend),
  the float lane is `pointer-events:none` so it never eats a tap, opening a story
  replays what people left, your own story shows count chips with no buttons, and
  the rail fits a phone between the stage and the footer. Skips without Chrome.
  `node scripts/test-story-start.js` covers where a story tap lands, offline
  (it runs the real `storyStartIndex` pulled out of `stories.js`): in a server,
  a person's row opens that person's first item instead of the tray's oldest
  post, a server row opens its first unseen item, and friend trays keep
  starting at the top.
  `node scripts/test-server-story-chip.js` covers the server sidebar Stories
  row's trailing chip, offline (it runs the real `serverStoryChip` pulled out of
  `stories.js`): an accent "N new" (unseen items) while something waits, a muted
  "SEEN" once everything is watched — never the bare grey author count that read
  as "1 unread" — and no chip at all when the only live post is mine. It also
  pins the row's accent ＋ as a SIBLING pinned over the row's trailing edge
  (`.srv-stories-wrap` owns the positioning; the row pays for the slot with
  `padding-right:2.7rem`), plus the phone hit box.
  `node scripts/test-story-sidebar-conn-browser.js` measures both sidebar
  surfaces in headless Chrome (offline checks first; skips without Chrome): it
  runs the REAL `renderServerStories` against the REAL `styles.css` beside the
  REAL Home Stories row and asserts the two ＋s land on the same pixel column —
  same distance from the sidebar edge, same left/right edge, same 24px circle,
  still in column with the GROUP CHATS ＋ — plus the ＋'s grown phone hit box and
  the voice bar's layout (the `#voice-conn` chip owns the trailing slot, a long
  room name ellipsises rather than pushing it out, and both stay inside the bar
  at 390px). Re-run after moving either Stories row, the voice bar markup, or
  the sidebar's row margins.
  `node scripts/test-story-add-entry.js` covers the two quick ways into the story
  camera (offline checks, then the real `#stories-nav-wrap` markup + `styles.css`
  and the real wiring and boot deep-link code from `stories.js`/`auth.js` in
  headless Chrome, skipping without Chrome — the harness is a phone's, so
  `isCoarse()` is true and the ＋ must land in the camera): Home's Stories row
  carries an accent
  ＋ as a SIBLING pinned over its trailing edge (never nested — a button cannot
  nest a button — and never a `div[role=button]`, which would drop the row out of
  the UA button font the Friends row above it renders in), it stays a 24px circle
  on desktop while a phone grows a ~42x44 hit box that fits inside the row and the
  gaps around it (the Friends row above keeps its taps), the ＋ opens the composer
  while the row still opens the story center, and the manifest's "Add to story"
  shortcut (`/?story=1`, in scope, with a served icon) boots straight into the
  camera with the param stripped first — while `?dm=`/`?friends=`/`?admin=reports`
  still win when both are present.
  `node scripts/test-story-new-menu.js` covers the desktop create-story chooser
  (offline checks, then the real `#story-new` markup + `styles.css` and the real
  `createStory`/`openStoryNewMenu`/`closeStoryNewMenu` and wiring in headless
  Chrome, skipping without Chrome): every create-story entry in the app goes
  through `createStory` and none opens the camera directly any more, a coarse
  pointer still gets the camera in one tap while a mouse gets the card, the card
  is a centred flat surface of three 42px-tile rows (camera / upload / text-only)
  that stack as comfortable targets and never overflow, opening it focuses the
  camera row, each row hands the composer the right thing with the server scope
  carried through (`{}`, `{text:true}`, `{file}`), upload keeps the menu up until
  a real file lands and refuses a non-media one out loud, the backdrop/✕/Escape
  put it away, a cancelled menu does not leak its options into the next open, and
  the composer skips the camera for `opts.file`/`opts.text` (with a refused file
  falling back to it). Writes `campfire-story-new-menu.png` to the temp dir.
  `node scripts/test-status-bubble.js` covers the custom status as a
  thought bubble beside the avatar (offline; it runs the real
  `statusBubbleHTML` pulled out of `pickers.js`): other people only get a bubble
  once they set something (whitespace-only counts as unset), my own card always
  keeps one ("Set a status" placeholder that opens the editor, plus a clear
  button once set), the expiry note only ever shows on my card and never for a
  lapsed timer, the text is escaped, and the old body section
  (`statusEditHTML`/`uc-statusbox`) is gone while the bubble still renders in the
  avatar row.
  `node scripts/test-mobile-nav-mebar.js` covers two surfaces in headless Chrome
  (skips without Chrome): the phone nav is a whole page — it covers the viewport
  edge to edge, the chat behind it is unreachable by hit test, it carries its own
  ✕, and it is off-screen while closed (the scrim, its CSS and its handler are
  gone) — and the me bar's click target is only the avatar + name: the
  mute/deafen/settings buttons are outside it with real dead space between, a
  hit test in that gap lands on the bar (and clicking it opens nothing), the
  avatar/name opens the card, and only the target reads as clickable.
  `node scripts/test-sidebar-banner-edge.js` covers the sidebar-banner ramp in
  headless Chrome (skips without Chrome): the real `paintSidebarBanner` paints a
  white banner at three device scale factors and the row's left edge must stay
  dark while the picture is still visibly painted, plus the recipe assertions
  (`no-repeat`, box-sized ramps) and that all three surfaces (me bar, member
  rows, DM rows) go through the helper instead of re-inlining the old
  cover/repeat style. The harness keeps a "vintage" row with the old recipe so
  it proves it can still reproduce the light edge.
  `node scripts/test-presence-widget.js` covers the presence switcher that now
  lives on your own user card as a vertical menu (offline; it runs the real
  `presenceWidgetHTML`, `statusLineHTML`, `presenceDurationSel`, `choosePresence`
  and `wirePresenceWidget` pulled out of `pickers.js`): it opens as just your
  current status (one collapsed row that doubles as the card's readout, and only
  for your own card — everyone else keeps the plain status line), opening it
  cascades the four states with the current one marked and Online offering no
  timer cascade, picking a state cascades its timer ladder underneath that row
  (with the live timer's nearest step marked and Forever when there is none, plus
  the "Until 3:55 PM" wall-clock note — `fmtUntil`, not a countdown), picking a
  span collapses the menu back to the readout while the card stays open, each row
  is wired to those semantics (a timer row converts its span to a future epoch —
  posting the raw span is a 400 `bad_expiry` the setter swallows, which is how
  DND could stick with no time shown — and applies the state it hangs off rather
  than the live status, re-picking your current state never clears a live timer,
  switching state carries it over, Online drops it, Forever keeps the state), and
  the menu renders in place with the card re-clamped after it grows. It also
  drives the real idle/`poke` block out of `final.js`: activity clears the idle
  auto-away but never a hand-picked one (the marker is per account in storage, so
  a reload keeps an idle Away revertible), and a timed Away keeps its own revert.
  Note the timer labels are the full "For 15 Minutes … Forever" ladder, straight
  from Discord's menu.
  `node scripts/test-search.js` covers the chat finder's message search
  (offline checks for `fmtAgo`'s buckets — "just now" / "10m ago" / "3h ago" /
  "5d ago", then the date once a week has passed — and for the `from:` operator's
  parser, then a throwaway database driving the real route over HTTP + WS,
  skipping without Postgres): an open DM is searchable and a DM you **dismissed**
  is not (it is out of your DM list, so it must be out of your results) while the
  other participant still finds it; a non-member finds nothing from a server;
  `from:handle` / `from:Display Name` / a half-typed handle all resolve (an
  unknown one reports `from.users === 0` so the panel can say "No one matches
  from:x" instead of "nothing matched"); an author-only query needs no text; and
  a message whose author's account was deleted comes back with `user: null`, is
  unreachable by that handle, and is labelled "Deleted user" by the panel — never
  the invented "Someone". Re-run after touching the search route, the find panel,
  `fmtAgo` or `parseFindQuery`.
  `node scripts/test-account-close.js` covers Settings → Account → Close account
  (static checks and a headless-Chrome harness for the dialog — it runs the real
  `renderDangerBox`/`openCloseAccount`/`submitCloseAccount`/`accountClosed` with
  the real `openModal` and `showAuth` — skipping only the browser half without
  Chrome, then a throwaway database over HTTP, skipping without Postgres): the
  danger zone lists both actions with what each does, delete opens a danger dialog
  whose confirm button carries the danger class and whose cancel reads "Keep my
  account", the bullet list is the real consequences, the button stays off until
  the password (+ a 2FA code when 2FA is on) and the typed username are filled,
  a refused attempt reopens with the reason in words and the answers still in the
  fields, success lands on the sign-in screen with the reason and no token, and
  the disable dialog drops the typed-name field while both drop the code field
  when 2FA is off. Against the real routes: a wrong password or a wrong 2FA code
  leaves the account untouched (with the eleventh guess a minute throttled),
  disable kills the session everywhere and blocks sign-in until a site admin
  re-enables it (the pre-disable token stays revoked after that, and 2FA
  survives), delete additionally requires the username — checked server-side, not
  just in the dialog — works with a backup code in place of the authenticator,
  and afterwards the account is gone (not disabled), its memberships cascaded and
  its messages still in their chats with no author; the instance owner's account
  is refused 'owner_protected' for both. Re-run after touching the account pane,
  `/api/me/disable`, `/api/me/delete`, `purgeAccount` or the admin delete route.
  `node scripts/test-user-card-layer.js` covers where the floating person
  popovers sit in the stack (static checks, then the real layers + stylesheet in
  headless Chrome, skipping without Chrome): the user card must beat the dialog
  layer — a card opened from the story "who watched" list was landing BEHIND that
  panel — while staying under the lightbox, the context menus and the toast, with
  the tag mini-panel one step above the card it opens from. It also pins what
  makes the tap work at all: `openUserCard` takes a fallback user (a viewer can be
  in no loaded roster), the viewers rows own their click and hand over the object
  they already have (`data-ownclick`, which the member-row delegate now respects),
  and a backdrop click dismisses the floating card before the panel underneath.
  The browser half asserts the card/tag panel are what a click at their centre
  actually hits with a dialog open, and that the panel needs the second click.
  Re-run after touching the card/tag z-index, the `[data-uid]` delegate or the
  story viewers list.
  `node scripts/test-user-card-actions.js` covers the card's action tabs, the
  me bar's missing server tag and the avatar-as-story-button (offline for the tab
  builders — it runs the real `ucTabHTML`/`UC_ICONS` out of `pickers.js` and
  `friendBtnHTML` out of `home.js` — then headless Chrome for the real `paintMe`
  and `paintUserCardStory`, skipping without Chrome): the tab rows are icon +
  label, full width and computed `flex-direction: column`, danger/primary are
  tinted, every action id is built through `ucTabHTML` (no `.btn small` pills
  left), the friend button takes the tab shape while the profile screen keeps its
  pill, the me bar renders the name with a tag-returning `tagHTML` stubbed (so a
  regression shows up), clicking the story avatar opens that user's story and
  closes the card (Enter too), a seen story is still labelled "(seen)", no story
  leaves the pfp a plain picture, your own card never becomes a button, and the
  full profile screen's picture behaves the same way (it is reused for every
  profile, so an expired story has to leave it clean).
  `node scripts/test-story-viewer-profile.js` covers the story viewer's header
  (offline checks, then the real `#story-view` markup + stylesheet in headless
  Chrome, skipping without Chrome): the header is ONE real `<button>` wrapping
  the picture, name and sub (not loose spans), a tap on the picture's own pixels
  hit-tests into it, it fits beside sound/more/close at a phone viewport, and
  clicking it closes the viewer *then* opens that author's profile — the profile
  sits under the viewer in the stack, and a viewer left running behind it would
  close itself mid-look; `svShow` arms the header with the current item's author
  and disables it when there is none, and `openProfileScreen` takes a fallback
  user for a poster who is in no loaded roster.
  `node scripts/test-story-center.js` covers Home → Stories as a full page
  (offline, then the real `renderStoriesPage` against the real `#stories-page`
  markup + stylesheet in headless Chrome, then the REAL app against a throwaway
  database — skipping the browser halves without Chrome and the app half without
  Postgres): the old `#story-rail` strip and its `storyTile`/`renderStoryRail`
  helpers are gone from the markup, the module and the stylesheet; `#btn-stories`
  opens the page while the server sidebar's row keeps its sheet; `S.homePanel` /
  `paintHomePanel` / the header + nav highlight / `openHome`'s reset are one
  contract, and every panel-hiding path hides both pages; the hero carries the
  post count, summed views, reaction emoji, hours left and a "See who watched"
  row (filled from the viewers route), opens your story, and its Add / Post
  buttons open the composer; the wall is one portrait card per person (unseen
  first, badged, then "Already watched", greyed), a tap opens that person, and
  the server strip opens that server's tray; the header's summary line hides
  itself rather than state "Nothing live right now" (the welcome panel below
  already says it) and the old "Stories last 24 hours…" footer note is gone —
  neither is to come back; with nothing live it is one welcome
  panel (never a hero *and* an empty card) with the how-it-works tips; the page
  fits a phone (two columns, no sideways scroll, the phone nav closes on tap);
  and in the real app clicking the sidebar row switches the panel, the highlight
  and the header together, with no uncaught page errors. Writes
  campfire-story-center{,-phone,-app,-app-phone}.png to the temp dir.
  `node scripts/test-story-scrim-corner.js` covers the story center's scrim
  corners (static checks always; the pixel half runs the REAL `spHero`/`spCard`
  out of `stories.js` against the REAL stylesheet in headless Chrome at 8x, and
  skips without Chrome): the scrim is a mask on the picture over the hero's own
  dark surface — never a second element painted over it, whose independently
  antialiased rounded clip left a hairline of the photo along the curve, loudest
  on the dark left/bottom corners. It renders a pure-white test photo and
  asserts no pixel inside the picture's rounded shape is brighter than the flat
  ramp at its own coordinate (or the hairline, whichever is brighter there) —
  the stacked version measures +42/+47, the masked one under +8 — plus that the
  ramp still runs the right way (white reads near-black at the dark end, bright
  at the light end). Re-run after touching the hero/card media, their scrims,
  their radii or `.sp-hero`'s background.
  `node scripts/test-story-audience.js` covers the removal of the instance-wide
  story audience (offline for the server half — it runs the real
  `normStoryAudiences` out of `server.js` — then the real `renderStoryAudience`
  against the real `#sc-pick` markup + stylesheet in headless Chrome, skipping
  without Chrome): `{everyone:true}` and the oldest `{audience:'everyone'}` shape
  both normalise to NOTHING (so the route answers 400 `pick_audience` instead of
  silently re-targeting friends), friends / servers / specific friends still
  normalise, a modern body with nothing selected never falls back to friends
  while the two legacy shapes still work, the route writes no `everyone` share
  row, the client sends no `everyone` key, and the menu's rows are exactly
  friends + the servers + the friends list with no instance-wide row. The read
  side is deliberately kept (the client's `storyData.everyone` merge, the
  server's tray query and visibility check) so a post from before the change
  finishes its 24h instead of vanishing early.
  `node scripts/test-pin-badge.js` covers the pin button's badge offline (it
  runs the real helpers pulled out of `pins.js` against stub globals): a pin is
  "new" until this account opens the panel in that conversation, pinning
  something yourself is never news, the memory is per account / per channel / per
  DM and survives a reload, an emptied pin list drops it, the store is capped
  (60 conversations, 90-day TTL), the server copy is merged in without un-reading
  anything, local reads are POSTed (coalesced) and a memory the server never
  received is pushed back.
  `node scripts/test-pin-badge-browser.js` drives the real page the same way
  (`test-drafts-browser.js`'s harness, second account joins by invite and pins
  over plain HTTP) and proves the badge lifecycle end to end: no badge for a pin
  I made, "1" for a pin someone else made (still there after a reload), gone
  after opening the panel, still gone after another reload. It also proves the
  cross-device memory: a browser with no localStorage pulls the server copy
  (1 new, not 3) and a read made elsewhere clears the badge here live, over the
  `pin-seen` push, with no reload. Skips when Postgres or Chrome is missing.
  `node scripts/test-pin-seen-sync.js` covers that server side against a
  throwaway database: the same account can read its memory back, its other
  sockets get the `pin-seen` push, other accounts hear nothing, an emptied list
  deletes the row, ids are deduped/capped and contexts and auth are validated,
  and the table stays bounded (200 conversations per account).
  `node scripts/test-games-manager.js` covers Settings → Games' server routes
  against a throwaway database: the manager payload (totals, per-game level +
  streak, live game), ignore / un-ignore one game by name, an ignored game that
  has no stats staying listed and being recoverable, removing playtime leaving
  detection and the ignore list alone, a watcher beacon re-tracking a game whose
  record was wiped, "remove all playtime" keeping the ignore list, "track all
  again" clearing it, and name validation + auth on every route.
  `node scripts/test-games-tab-browser.js` drives the real tab in headless
  Chrome (same harness as `test-drafts-browser.js`) and proves the UI offers
  those controls: the summary/chips/rows render, the row menu toggles
  Ignored → Track again, an ignored game with no playtime is listed, search
  filters in place, tracking by name works, "Remove all playtime" wipes stats
  but never the ignore list, and the state survives a reload. Writes
  `campfire-games-tab.png` to the temp dir. Skips when Postgres or Chrome is
  missing.
  `node scripts/test-mobile-home-nav.js` drives the real page in headless Chrome
  at a phone viewport against a throwaway database and pins that behavior: the
  campfire Home button tapped with a real touch keeps the nav page up (still
  slid in, chat behind it unreachable) while landing on Home and restoring the
  tab you were on — synchronously, so the conversation is back in the same task
  as the click instead of popping in behind the roster refreshes — plus Home
  from inside a server leaves the home lists, with a DM row in the panel to
  pick, and picking it closes the page and opens that DM (the ✕ still closes
  too). Skips when Postgres or Chrome is missing.
  `node scripts/test-home-tab-return.js` covers the campfire Home button coming
  back to the tab you were last on (offline for the two real memory helpers —
  `readHomeTab`/`rememberHomeTab` sliced out of `core.js` — plus static wiring
  checks, then the REAL app against a throwaway database at a desktop viewport,
  skipping without Postgres or Chrome): the memory is per account (a second
  account never inherits it, junk in the store falls back to Friends), which
  paths remember it (opening a DM or group, the Friends row, the Stories row)
  and which clear it (Close DM, Leave chat, a thread that vanished or a group
  you were removed from), the campfire button is the ONLY entry that restores
  (every internal jump into Home still lands blank and picks its own
  conversation), and end to end: DM → server → Home lands back in that DM with
  its header and its `.active` sidebar row, a group chat comes back by name,
  the Stories and Friends tabs come back as themselves, a closed DM never comes
  back, the memory survives a reload, and there are no page exceptions.
  `node scripts/test-group-dm-settings.js` covers group chat settings. The
  offline half slices the real `dmMenuItems` out of `home.js` (a group row
  offers Edit group chat / Add members / Leave, a 1:1 row keeps Close DM and
  nothing else), the real `tagHTML` out of `core.js` (`tagHTML(u, true)` renders
  a decorative pill with no `data-tag-sid`/role/tabindex, which is what the DM
  sidebar passes so the tag cannot steal the tap into its server mini-panel),
  and that `actions.js` routes a coarse-pointer hold on `[data-dmthread]` to
  `openDmSheet` and the stylesheet opts `.server-btn,.chan,.dmrow,.member` out
  of text selection. It also pins group removal: `canRemoveGroupMember`
  (actions.js) is the one rule — creator only, never yourself, never the
  creator, never a 1:1 — `groupRemoveTabHTML` (pickers.js) turns it into the
  card's danger Remove tab, the row-menu item goes through the same predicate,
  and the card only looks the open thread up in home view. Against a throwaway
  database the `PATCH /api/dms/:tid` route is pinned: members rename/describe, a
  non-member gets 404, a 1:1 gets `not_group`, a blank body gets
  `nothing_to_update`, a blank name falls back to "Group chat", name caps at 40
  and description at 300 after trim + newline squash, and every member gets the
  live `dm-threads-changed`. The
  `POST /api/dms/:tid/members/:uid/remove` route is pinned the same way:
  auth 401, a non-creator member gets `creator_only`, the creator cannot remove
  themselves (`cannot_remove`), a stranger and a second attempt get
  `not_member`, a 1:1 gets `not_group`, and a real removal pushes
  `removed-from-dm` to the removed member, drops the group from their list and
  posts the "was removed" system line. Skips the API half when Postgres is down.
  `node scripts/test-group-dm-browser.js` drives the real page in headless
  Chrome at a phone viewport with real touch events against a throwaway
  database (skips without Postgres or Chrome): a long-press on a group row
  opens the `.sheet` headed by the group name with Edit group chat and never
  the desktop `#ctx-menu`, the row opens the settings modal prefilled, saving
  repaints the sidebar row, the open header name and the description as the
  topic line; a 1:1 row gets the sheet too (Close DM, no group settings); the
  hold selects no text (`user-select:none` on the rows); and clicking the plain
  tag in a DM row opens the conversation without opening `#tagcard`. It also
  removes a member for real: the member row's right-click menu and the user
  card both carry Remove for the group creator, the card shows no server
  Kick/Ban in a group, clicking it confirms first, closes the card, and the
  member really leaves the group (sidebar repaints, system line lands in chat).
  Writes `campfire-group-dm-sheet.png` and `campfire-group-dm-card.png` to the
  temp dir.
  `node scripts/test-anow-strip.js` covers the phone's Active Now strip in
  headless Chrome at a phone viewport with injected friends: the strip sits
  under Stories and above DIRECT MESSAGES, one tile per online friend (the one
  in a room first), the row really scrolls horizontally, only a reachable voice
  room offers Join, it disappears when nobody is online, it stays out of the
  way on desktop (where `#members` is the rail), and it stays fed while a DM is
  open. Writes phone/desktop screenshots to the temp dir. Skips when Postgres
  or Chrome is missing.
  `node scripts/test-mobile-landscape.js` covers the phone held sideways, the
  one gate on the whole landscape fix: every mobile @media block in styles.css
  must carry `(max-width:700px), (max-height:560px) and (pointer:coarse)` (the
  members drawer, the full-page nav, settings/profile sheets), no module may
  decide layout on the raw 700px width query any more, and in headless Chrome
  over CDP (touch emulation is what makes `pointer:coarse` true) the shell at
  852x393 / 667x375 / 915x412 must be Discord's three-pane shape — the server
  rail + channel sidebar are persistent columns on the left, the chat takes the
  rest of the width beside them, the portrait full-page nav (`body.nav-open`) is
  inert there (it must move nothing), and the chat ☰ / nav ✕ are hidden — with
  the members panel an off-screen right drawer (never a static column), header
  buttons unclipped and non-overlapping, every bottom sheet/modal/profile
  fitting the short viewport, and the story composer's tool rail clearing the
  caption slot and the Next bar. It also fills the sidebar with more
  channels than fit and proves the list scrolls (with a sticky server header)
  while the me bar stays pinned on screen — it used to be pushed off the bottom.
  It also pins that the auth screen
  scrolls to its Log in button in landscape (it used to sit below a 393px
  viewport with nothing able to scroll) and that portrait keeps the full-page
  nav (chat full width) while a short *desktop* window (fine pointer) keeps the
  desktop shell. Skips without Chrome.
  `node scripts/test-viewonce.js` covers view-once messages against the same
dev server: the media gate (unsigned/tampered tickets), per-friend DMs, the
  one-replay lifecycle, and that unopened items never expire.
  `node scripts/test-upload-pipeline.js` covers the whole upload pipeline
  end-to-end against a throwaway database with a fake (slow) clamd on loopback,
  in the two shapes production runs. **Scan mode** (`VIRUS_SCAN=1`): the message
  renders the file as pending, exactly ONE `message-updated` follows carrying
  bytes the scanner also approved, the old key is deleted on a format change and
  `file_scans` follows the new one; the sweeper fallback still compresses a file
  the slot never saw. **Compression-only mode** (the server is restarted with
  `VIRUS_SCAN=0`, no clamd at all — the Civo cluster's shape): a candidate upload
  is gated (423) until the slot publishes it and then raises ONE transition with
  no clamd contacted, a file below `MIN_BYTES` is served the instant it lands,
  and a sweeper-compressed file that clients could already fetch lands on a NEW
  key with the old object left intact (never rewritten in place, nothing
  referencing it, so the orphan sweep reaps it). Skips without ffmpeg or
  Postgres. On Windows run it from Git Bash: `haveBinaries()` probes with `sh`,
  and a PowerShell session has no `sh` on PATH, so the scan-mode phase silently
  falls back to the no-engine path and its checks fail.
  `node scripts/test-viewonce-pick.js` covers "Send a view-once" arriving with
  the DM you clicked it in already picked (offline for the two real helpers —
  `viewOnceDmPeerId`/`viewOncePrePick` sliced out of `stories.js` — then the
  real `renderStoryAudience` against the real `#sc-pick` markup + stylesheet in
  headless Chrome, skipping without Chrome): a 1:1 DM hands over its peer, a
  server channel and a group chat hand over nobody, a peer who is not a friend
  is never pre-picked (the picker lists friends and the server drops everyone
  else, so the menu must stay honestly empty rather than read "1 selected" with
  no row), the row arrives lit and `aria-pressed` with the count and the Send
  label agreeing, and a second friend still toggles on normally.
  `node scripts/test-admin-stats.js` covers the site-admin Overview numbers
  against a throwaway database: distinct-user Online count vs sessions (two
  tabs are one person), invisible users excluded, and the live
  `admin-presence` WS push that keeps the panel current without a refresh.
  `node scripts/test-reports.js` covers message reports end-to-end against a
  throwaway database: members-only reporting (never your own message, once
  while open), the snapshot surviving the message's deletion, admin-only
  access, search/counts, the live `report-new`/`report-updated` pushes and the
  inbox entry, one decision closing every open report on the same message, and
  the delete / delete+disable / disable / ban / dismiss actions.
  `node scripts/test-owner-protection.js` covers the owner lock against a
  throwaway database: a second site admin gets `owner_protected` from every
  account route and from the account-level report actions, the owner still
  manages their own account and other users, and ordinary users are unaffected.
  `node scripts/test-composer-drafts.js` covers the composer draft store
  offline (it runs the real functions pulled out of `core.js`): per-conversation
  keys, filing a keystroke under the conversation it was typed in, sends
  clearing the draft even mid-debounce, TTL/cap pruning and per-account
  isolation. `node scripts/test-drafts-browser.js` drives the real page in
  headless Chrome over CDP against a throwaway database and proves typing
  survives a reload (the auto-updater's exact path) in channels and DMs, that
  conversations keep their own drafts, and that a sent message leaves none.
  Skips when Postgres or Chrome is missing.
  `node scripts/test-composer-preview.js` covers the composer's markdown
  backdrop offline (it runs the real `renderRich` out of `core.js`): in
  `{plain:true}` mode stripping the tags off the preview gives back the
  escaped source text character for character (that is what keeps the
  textarea's caret sitting in the text it looks like it is in — the backdrop
  used to drop `**`/`||`/backticks, which drifted the caret left), markdown
  delimiters stay in the flow (dimmed), message rendering is unchanged, and
  the `#in-render` rules stay metric-neutral (no padding/size/weight/font
  changes — `.spoiler` and `<code>` have to override the generic rules).
  `node scripts/test-role-mentions.js` covers server-role mentions and the
  admin-only `@everyone` / `@here` offline (it runs the real `renderRich` out of
  `core.js` plus the real `mentionsToken`/`mentionedRoleIds` out of `server.js`):
  a role renders as its own chip in the role's colour and highlights as "me"
  when you hold it, the longest role name wins (`@Mod Team` is never also a ping
  of a role called `Mod`, and `@Moderator` is neither), `@everyone`/`@here`
  render only from an owner's or an admin role's message (a plain member's stays
  plain text — and so does any render with no author, e.g. a bio), usernames and
  username-only DMs are unchanged, the client and server matchers agree
  token-for-token, the notifier resolves the author's admin status before it
  pings, and the composer never offers `@everyone`/`@here` to a non-admin.
  Re-run after touching `renderRich`, the mention helpers, `mentionsMe`,
  `canManage` or the mention autocomplete.
  `node scripts/test-role-mentions-e2e.js` proves the same rules against a real
  server on a throwaway database (headless Chrome over CDP for the UI half;
  skips without Postgres, and skips only the browser half without Chrome): a
  member's `@everyone` lands in nobody's inbox while the owner's — and an admin
  role holder's — reaches every member including offline ones, `@here` reaches
  only members with a live socket, `@Role Name` reaches exactly its holders, the
  composer's autocomplete offers roles to a member but neither `@everyone` nor
  `@here` (and offers both to the owner, inserting the mention text), and the
  chat renders a broadcast chip for an admin's `@everyone`/`@here` and a
  `data-rid`/`--rc` role chip for a role mention, while a member's `@everyone`
  paints as plain text.
  `node scripts/test-composer-field.js` covers the composer's field itself
  (offline checks, then the real `index.html` + `styles.css` in headless Chrome,
  skipping without Chrome): the field has its own `--field`/`--field-line` pair
  in all four themes and is no longer painted with the login-input `--inset`
  well; the textarea's and the backdrop's computed padding stay IDENTICAL (any
  drift there puts the caret off the glyphs); the leading `+` sits fully inside
  the field and centred on a one-line box while its thumb target comes from a
  `::after` hit box (it used to be thumbs-sized itself, which made it overflow a
  47px field and get clipped by the corner); `#composer` bottom-aligns its
  children so a box grown to four lines keeps every control on the bar; the `+`
  menu's seven rows all carry an icon; and the send key reads the box through
  the real `paintComposerSend()` — muted and disabled when empty, whitespace-only
  or with no conversation behind it, lit for text or an attachment-only send.
  It also pins that the send key and the `+` are hover-styled only inside the
  one `@media (hover:hover)` block.
  `node scripts/test-friend-click.js` drives the same harness and counts
  `openUserCard` calls: a friend row under All/Online opens the DM and nothing
  else (the row carries `data-uid` for the story ring, and the global
  `[data-uid]` click delegate in `pickers.js` used to stack the card on top;
  the tag is rendered `tagHTML(u, true)` — decorative — so a tap on a friend's
  server tag opens the DM and never the server mini-panel, which used to stack
  on top of it),
  the row's Message / More → View profile affordances still work, and a
  pending request row or voice occupant opens exactly one card. Rows that own
  their click declare it with `data-ownclick` — give that attribute to any new
  `data-uid` row with its own click handler, or the delegate will fire too.
  `node scripts/test-story-camera.js` drives the same harness with Chrome's
  fake camera (`--use-fake-device-for-media-stream`) and proves the story
  shutter answers the tap instead of the JPEG encoder: the captured frame is on
  screen in the same frame as the click (`.sc-freeze` = the capture canvas, the
  camera released, Next live immediately), a real `image/jpeg` blob takes over
  once the encoder answers, a reset while an encode is in flight (`storyRetake`,
  which the failed-encode fallback still calls — there is no Retake button in the
  composer, and the test pins that too) discards the
  stale shot instead of resurrecting it, and posting before the bytes land
  waits for them (Post says "Saving…") and then posts. Skips when Chrome has no
  fake video device. Re-run it after touching the story composer's capture or
  encode path.
  `node scripts/test-camera-busy.js` covers the camera button's loading state in
  a call (offline for the flag, headless Chrome for the paint, skipping without
  Chrome): the real `paintVoiceControls` puts `.busy` on all three camera
  buttons (`#btn-camera`/`#vf-camera`/`#cv-camera`) while `camBusy` is up, drops
  the red off state and says "Starting camera…" — and the flag cannot park or
  leak: `toggleCamera` refuses a second tap, clears it on a blocked camera, on
  a call left mid-prompt (the camera is stopped, not attached to a dead
  session), and after the first frame lands, with a 3 s cap on that wait and a
  clear in `leaveVoice` too; `camBusy` must also be declared above the
  top-level `paintVoiceControls()` call or boot dies in the TDZ. In Chrome the
  icon really disappears behind a 14px up-spin ring (18px on the big call-view
  button), the ring sits inside the button box, the box never changes size, and
  the busy button keeps its own surface instead of the off red.
  `node scripts/test-voice-conn-status.js` covers the sidebar voice bar's
  connection readout, offline (static markup/CSS/wiring checks, then the REAL
  `voiceConnInfo`/`paintVoiceStatus` out of `voice.js` against a fake DOM, a fake
  `RTCPeerConnection.connectionState` set and a fake socket): alone in a room is
  Connected (the mic is captured, there is no link to build), a negotiating peer
  reads Connecting…, a live one green, a working peer plus a joining one reads
  Reconnecting… rather than a false green, a failed/disconnected link stays amber
  (never a green lie) and is remembered until it recovers — with a grace window
  so a renegotiation does not flash it — a dropped signaling socket reads
  Reconnecting…, `navigator.onLine === false` reads Disconnected in red, the
  throttle schedules a trailing repaint instead of freezing on the first peer,
  and leaving the room clears it. Also pins the amber `vc-pulse` dot (and its
  reduced-motion opt-out) and that a failed peer connection is retried rather
  than torn down.
  `node scripts/test-story-overlays.js` covers the story-markup model offline
  (it runs the real `ovSanitize`/`ovParse`/`ovContentRect` out of
  `public/js/story-edit.js` and the real `storyDestDims`/`storyDrawFrame` out of
  `public/js/stories.js`, with a recording canvas for the framing math): junk
  items dropped and every number clamped, the text/item/point caps, the payload
  budget (a stroke is dropped before text is, so a post never 413s), the
  normalized-coordinate round trip, and that the capture crops exactly the
  rectangle the cover-fitted preview showed (cover + zoom + pan, pan included
  in the crop). Plus static wiring checks (the four overlay layers, the tool
  markup, `story-edit.js` in the SW shell, no leftover `.sc-mode`).
  `node scripts/test-story-markup-browser.js` drives the real composer end to
  end (same harness + fake camera) and pins the overhaul: the viewfinder covers
  the stage, a two-finger pinch lands at ~2x with the preview transformed to
  match (and `storyNeedsComposite()` true, so what is recorded is what was
  seen), double-tap flips the camera, holding the shutter records and releasing
  it finishes a real video, markup on an empty shot draws on the first stroke,
  text paints as you type and stays centred, undo drops a stroke, a sticker
  drags and a tap on empty space deselects, the post carries the markup through
  the server (which caps/drops what a hostile client sends) and the viewer
  re-renders it over the picture, a text-only story generates a background that
  does not re-shape when the swatch changes, and a story sent to one friend
  keeps its markup in the one-shot player, and that the rail's ring thumbnail
  composites a story's markup (a text-only story used to preview as a bare
  gradient) — including the 423 retry a just-uploaded story needs. Writes
  campfire-story-edit.png / campfire-story-view.png / campfire-story-text.png to
  the temp dir. Skips when Postgres, Chrome or the fake camera is missing.
  Re-run it after touching the composer, the markup renderer or the story
  routes.
  `node scripts/test-story-ring.js` covers the rail ring's cookie-cutter
  thumbnail (offline; runs the real `storyRing()` extracted from `stories.js`,
  plus the overlay model inlined from `story-edit.js`, against the real
  `styles.css` in headless Chrome, skipping when Chrome is missing). It
  screenshots the ring at four device scale factors, at both ring sizes (the
  rail's 58px, the stories sheet's 44px) and in all three states (unwatched /
  watched / your own), asserting no pixel of the avatar behind it survives
  around the photo's edge, that the ring stroke and its gap are still there (so
  "cover the whole ring" can't pass), that the photo is centred, and which
  states are desaturated: only a watched story that isn't yours is muted, because
  greying your own post made a flat-coloured (text-only) story read as a broken
  thumbnail. Re-run it after touching `.st-ring`/`.st-thumb`; Blink flooring the
  avatar's 2.5px border to whole device pixels, and the seen thumbnail's filtered
  layer edge, are what makes the old face peek through — do not reintroduce the
  face behind a live thumbnail.
  `node scripts/test-story-swipe.js` covers swipe-down-to-close in the story
  viewer (offline; runs the real tap-zone + swipe wiring sliced out of
  `stories.js` against the real `#story-view` markup and `styles.css` in headless
  Chrome, skipping without Chrome): `.sv-stage` must compute `touch-action:none`
  (it was `pan-y`, which handed the drag to the scroller and cancelled the
  pointer stream, so the swipe never landed), a downward drag closes whether it
  starts on the picture or on a stage-covering tap zone, and that same drag must
  not step the story (the zones fire on any pointerup unless movement is
  treated as a swipe). The drag moves the WHOLE `#story-view` overlay — bars,
  header (✕/sound/more) and footer travel with the picture 1:1 — and then it
  carries on to `translateY(100%)` off the bottom before the viewer tears down
  (the pending teardown holds the viewer instance, so a close+reopen mid-slide
  can't close the new one). It also pins the rest of the gesture set: short and
  sideways drags neither close nor step (and spring back), plain taps still step
  forward/back, press-and-hold pauses and resumes without stepping, and a quick
  flick never pauses.
  `node scripts/test-swipe-dismiss.js` covers swipe-down-to-dismiss for the
  mobile panels (offline; runs the real `swipeDownToClose` sliced out of
  `final.js` against the real `#profile-backdrop` markup and `styles.css` in
  headless Chrome with real TouchEvents, skipping without Chrome): the profile
  page and the me-bar `.sheet` card follow the finger and close past the
  threshold (the class is only honoured while the card IS a sheet), a drag that
  starts below the top of the scroller or travels upward is left to the scroller
  (`touchmove` is not preventDefaulted), a short drag springs back, and the
  synthetic click a drag produces is swallowed so the row under the finger never
  also fires. Touch events, not pointer events, are the point: the panel body is
  a scroll container, so a pointer drag at the top is an overscroll pan the
  browser cancels. `closeProfileScreen`/`closeUserCard` must clear the inline
  `transform`/`transition`/`animation` the drag leaves behind, or the next open
  skips its entry animation.
  `node scripts/test-video-placeholder.js` covers the video attachment's
  loading state (headless Chrome + a generated mp4, skipping when Chrome or
  ffmpeg is missing; it runs the real `attachmentHTML` video branch and the
  real poster block pulled out of `messages.js` against the real
  `styles.css`): until the captured poster frame lands the element is hidden
  behind `.att-vid-load` (a dark panel with `.att-spin`), the overlay covers
  the video's box exactly and a centre tap lands on it rather than the
  browser's grey play-button placeholder, a captured frame reveals the video
  with a `data:` poster, a failed capture (404) still reveals it instead of
  leaving a stuck spinner, and tapping the overlay on a slow video reveals it
  immediately — the spinner doubles as the play affordance it replaced. Keep
  `revealVideoShell` on both exits of `ensureVideoPoster` or a failed capture
  parks on the spinner forever.
  `node scripts/test-lightbox.js` covers the photo lightbox (headless Chrome,
  skipping without Chrome; it runs the real lightbox block pulled out of
  `pickers.js` against the real `#lightbox` markup and `styles.css`): the
  Download/Close controls live in `#lb-bar`, a fixed safe-area row, so they stay
  fully inside the viewport and hit-testable for tall/wide/square photos on
  phone portrait, phone landscape and desktop (the bug: an unsafetied corner
  anchor on a tall photo sat off the top of the screen); the photo never
  overflows the stage; a single mouse click toggles zoom while touch keeps
  double-tap, and pinch also zooms (panning a zoomed photo does not close it); a
  downward drag past the threshold dismisses the viewer while a
  short drag springs back; a tap on the backdrop or Close closes, a tap on the
  photo does not, and tapping Download does not; and closing/reopening resets the
  zoom.
  `node scripts/test-chan-unread.js` covers unread channel dots and the rail's
  unread badges (offline; runs the real helpers sliced out of `servers.js`
  against a fake DOM + localStorage, then checks the render/menu/socket wiring
  and stylesheet statically): a background message marks its channel and counts
  up the server's badge (`data-unread`, rendered by `content:attr(...)`, capping
  at 99+), a collapse folder sums its servers while the numbers inside stay
  their own, the memory is per account and survives a reload (and another
  account never inherits it), the store is capped and forgets marks past its
  TTL, "Mark all as read" clears exactly the marks a server or a folder owns and
  persists that, opening a channel clears it (and a hidden-tab message on the
  open channel clears when the tab returns), and the row repaints in place.
  `node scripts/test-rail-unread-badges.js` drives the same badges in a real
  browser (headless Chrome against a throwaway database, desktop viewport,
  skipping without Postgres or Chrome): it marks channels unread on three
  servers, one folder holding two of them, then measures the generated
  pseudo-elements — the count in the app red, white on a 999px pill pinned to
  the icon's corner, the icon still inside the rail — and walks the folder
  hand-off (collapsed shows the sum, expanding hides the folder's circle and
  puts 2 and 1 on the servers, retracting restores the 3 without reading
  anything), the active server keeping its count for another unread channel, and
  both menus end to end: a read server offers no "Mark all as read", an unread
  one offers it as the last row, and the folder's flyout clears every server in
  it while leaving a server outside it alone.
  `node scripts/test-touch-hold-hover.js` covers the "one row looks already
  selected" bug when a long-press slides its sheet up under a finger that is
  still down (offline; runs the real `suppressHoverFromTouch`/
  `noteTouchStart`/`noteTouchMove` out of `actions.js` against a fake classList
  and clock): nothing is suppressed for a menu that was not opened out of a
  recent touch (`openCtx`/`openCtxSheet`/`openMsgSheet` all call it, so a
  desktop right-click keeps its hover feedback), the class goes on for a
  touch-opened menu and comes off on the next touch or a real move, and the
  stylesheet neutralizes every `:hover` such a menu can paint under
  `body.touch-hold` — the last check sweeps the sheet/ctx hover rules, so a new
  row added without a guard fails the test instead of glowing.
  `node scripts/test-mobile-settings-sheet.js` covers the phone's settings
  master/detail and the me-bar card sheet (offline static checks plus headless
  Chrome at a phone and a desktop viewport, skipping without Chrome — note
  headless clamps the layout viewport to 500px, so the phone case runs at 500).
  It drives the real `openOwnCard` (`security.js`) and the real settings view
  helpers (`settings.js`) against the real `index.html` markup + `styles.css`:
  on a phone the open card carries `.sheet`, with the popup's inline geometry
  cleared so the CSS wins, pinned bottom/full-height/edge-to-edge with a rounded
  top; on desktop there is no sheet class and the 300px popup stays
  bottom-anchored. Settings opens on the menu (rail rows visible, body and
  detail header hidden, rail close hidden), a section row shows it alone with
  back on the left half and close on the right half (and the header fits, so the
  close is never clipped), back returns to the menu, the detail title comes off
  the row label, and the view classes are inert on desktop.
  `node scripts/test-native-back.js` covers the native shell (`js/native.js`)
  against a throwaway database with a real phone viewport and real touch input,
  skipping without Postgres or Chrome: on a touch device the first touch arms
  the history sentinel (and nothing arms before it — the auth screen must keep
  the back button), one back press closes exactly ONE thing topmost-first (the
  user card, then a picker stacked on settings, then settings, then a modal,
  then the members drawer), back from a channel or a DM opens the nav page
  rather than leaving the app, the press after that closes the page and keeps
  the conversation, the shell re-arms after each handled press, Escape peels
  the same list without one throwing (it used to die on a `closeStatusMenu`
  that does not exist, which killed every layer below it), a swipe in from the
  left edge opens the nav page and a swipe back out closes it while a vertical
  drag from the edge is left to the list, every back layer's predicate can be
  evaluated (a throwing predicate is swallowed and silently disables that
  overlay — which is how nine of them were un-backable the first time round),
  each header icon button carries a ≥44px hit box that never steals its
  neighbour's tap, and a fine pointer (desktop) pushes no history entry at all.
  `node scripts/test-dm-unread.js` covers the unread-DM badges under the campfire
  (offline for the client half, then a real server against a throwaway database,
  skipping without Postgres): they used to be a per-tab tally built from live
  `dm-new` pushes, so the reload the auto-updater fires after a deploy dismissed
  every one of them. It drives the real `refreshDms`/`markDmRead` out of
  `home.js` against fakes (a server count becomes the badge, a gone thread drops
  it, the chat being read never keeps one, opening reports the read and a burst
  in the open chat is one write) and checks the wiring statically, then over HTTP
  and a live socket: the receiver's `/api/dms` reports the message as unread for
  a fresh page load while the sender's never does, marking read clears it
  durably and is pushed back to the account as `dm-read`, a later message is
  unread again, a stranger gets a 404 and no auth a 401, a member added to an old
  group chat joins caught up (their start line is `joined_at`, not the dawn of
  time) and the next message counts, and a system line never counts as unread.
  It then drops the column to rebuild a pre-migration database, restarts the
  server, and asserts the ALTER + backfill ran as one unit (every pre-existing
  membership stamped, an old unread DM not resurrected) and that the backfill
  stays one-shot — a plain restart must not mark a live unread message read.
