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
  `node scripts/test-dm-row-marks.js` covers the marks on a DM row staying
  legible over the person's banner (static checks plus a headless-Chrome pixel
  proof; skips without Chrome). Both trailing marks had it: the pin was a bare
  accent-coloured outline and the ✕ a bare grey one, and they sit in the row's
  trailing column — exactly where a banner paints its brightest pixels, since the
  ramp only darkens toward the left. The test asserts the pin is a filled
  `--accent` disc with an `--on-accent` glyph (18px, centred, `currentColor` so
  the chip decides how the glyph reads), that nothing re-colours the glyph behind
  the chip (a higher-specificity colour on a filled disc hides it — the trap this
  rule replaced), and that a bannered row's ✕ takes the dark `.att-dl` scrim with
  a white glyph, darkening rather than changing hue on hover while the flat-row
  danger-wash hover is left alone (it also computes that the scrim keeps the
  glyph above 4.5:1 even over a pure-white picture). It then paints a PURE WHITE
  banner through the real `paintSidebarBanner`, screenshots at dpr 1 and 2 and
  samples the inside of each mark — every sample must still be that mark's own
  fill (accent for the pin, a flat dark scrim for the ✕), never the picture.
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
  It also pins the click that OPENS a card not being read as a click outside it:
  the closer is a document-level listener, so it runs after the row's own handler
  in the same click, and with a warm friend list the card is already painted by
  then — which is what made the Active Now rail and a 1:1 DM's header name look
  dead. `openUserCard` stamps the click it was asked for (a counter bumped in the
  capture phase, `ucOpenedByThisClick`) and the closer consults it.
  Re-run after touching the card/tag z-index, the `[data-uid]` delegate, the
  card's closer in `final.js` or the story viewers list.
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
  profile, so an expired story has to leave it clean). It also pins the DM-header
  route into the card: `#chat-header`'s click handler resolves the open 1:1 DM's
  peer and calls `openUserCard(..., { sheet: phoneLayout() })`,
  `paintDmHead`/`paintHeaderNameTap` marks the header only for a 1:1 (every other
  header painter clears it), the `.dm-name-tap` cursor/hit-box/`:active` rules are
  in the stylesheet, and the shared `userCardAsSheet()` really does leave the card
  full-screen from the bottom edge at a phone viewport (measured after its entry
  animation is taken out of the way). Re-run after touching `openUserCard`, the
  card's action list, the header name tap or the sheet CSS.
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
  `node scripts/test-push-native.js` covers the native push socket the Android
  app's notifications ride on (`/ws/push`) — it exists because Android WebView
  implements neither `PushManager` nor `Notification`, and the shell pauses the
  WebView the moment the app is backgrounded. Source checks first (every payload
  reaches the device sockets from `pushToUser`, a peer replica's fan-out rides
  the bus, web push keeps the account-wide page-visible gate, the service is
  declared `stopWithTask=false` + `specialUse` + `POST_NOTIFICATIONS`, its url is
  `/ws/push`, and the page's bridge + deep-link routing are wired — plus the
  cancel-loop guards: `connect()` replaces the live socket, OkHttp reports a
  cancelled call as `onFailure`, and an unguarded listener turns that into a
  reconnect every three seconds forever, so the listener must be
  generation-guarded and a deliberate teardown must not schedule a reconnect),
  then a real
  server and a real socket: a DM pushes the exact OS payload (title/body/tag/url)
  web push would have carried, the payload never rides a chat socket, the device
  socket registers no `live_sessions` row (the phone stays offline while its
  service is connected), that socket's own visibility is the only suppression, a
  visible page on another device does NOT silence the phone, mute prefs still
  suppress everything, the settings test push arrives while the app is on screen
  and carries `test`, a device that reported itself visible and then stopped
  reporting is delivered to again once its visibility lease lapses (this run
  shortens `PUSH_VISIBILITY_TTL_MS`; the cluster runs 75s), and a bad token is
  closed 4401; then the page side runs the
  REAL `renderNotifsTab`/`pushSetup`/`pushTeardown` against a minimal DOM in all
  three shells — the Android bridge (off by default, enabling asks for the
  permission and hands over the session, the enabled state reads back, the test
  button posts `/api/push/test`, the two action buttons share a spaced
  `.set-btns` row instead of touching, turning it off stops the service, and boot/
  sign-out configure it without ever trying a browser subscription), the desktop
  shell (the "app handles them" copy, and a test button that calls the native
  `notify` command), and a plain browser (still the web-push copy). Skips when
  Postgres is missing for the socket half; the source/client checks always run.
  Re-run after touching `pushToUser`/`notifyPushSockets`, the `/ws` upgrade
  routing, `public/js/final.js`'s native bridges, `PushService.kt`'s connection
  handling, or Settings → Notifications.
  `node scripts/test-upload-stall.js` covers a stalled upload (reported live: a
  36 KB PNG's card sat on "Finishing…", the bytes were in the bucket and the
  compression verdict landed 0.5 s later, so the answer had simply been lost —
  a half-open connection or a phone that slept leaves an XHR pending with NO
  event at all). It drives the REAL watchdog sliced out of `public/js/messages.js`
  on a virtual clock: the body being out switches to a short answer ceiling
  (90 s, not the old five minutes), no progress for a minute fails a transfer
  that is still going out, steady progress is never a stall, an unknown size is
  judged by silence alone, a done entry is never failed, `sweepStalledUploads()`
  fails an overdue upload the moment the page is foregrounded again (background
  timers are throttled there), `detachUpload` strips an abandoned attempt's
  handlers so a late answer cannot add a second attachment, plus the source-level
  wiring (watchdog armed from the send rather than from a progress event, cancel
  detaches, final.js sweeps on foreground). Offline, no browser. Re-run after
  touching the upload watchdog, `startUpload`/`cancelUpload`/`retryUpload`, or
  final.js's visibility handler; `scripts/test-upload-cards.js` (headless Chrome)
  covers the same ceilings through the real card UI.
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
  open. Its last section drives a real touch on a rail row and on a tile with the
  friend list marked warm (`friendsAt`, which is what made `ensureFriends()`
  no-op and the card die in the same click) and asserts the tap opens that
  friend's card — the desktop popup left of the members panel, the phone tile as
  the full-height sheet — that a click outside still closes it, and that Enter on
  a tile opens it as well.
  Writes phone/desktop screenshots to the temp dir. Skips when Postgres
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
  desktop shell. The header it measures is the phone's spare one: the secondary
  rails (search, notifications, threads, pins, members) are hidden by the phone
  block and the ⋯ sheet stands in, so the header checks assert that ⋯ is offered
  and the members drawer is still reachable (button or sheet), never that five
  icons are on screen. Skips without Chrome.
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
  no clamd contacted, a non-media upload (a zip/text file) is served the instant
  it lands while a tiny image is gated like any other and still published after
  the encoder declines to rewrite it (`no_saving`), and **concurrency** really
  is parallel: four rows are planted at once and the worker's own high-water
  mark (`worker.peak`, reported by `/api/admin/media`) has to show more than one
  encode in flight and never more than `MEDIA_COMPRESS_CONCURRENCY`, and a tiny
  image that was posted has to appear in the panel's feed whether it was kept or
  compressed — with the reason it was left alone when it was kept, so "examined,
  nothing to gain" can never look like "never looked at",
  and a sweeper-compressed file that clients could already fetch lands on a NEW
  key with the old object left intact (never rewritten in place, nothing
  referencing it, so the orphan sweep reaps it). Then the coverage the flags
  cannot reach: **story media** (a story row is created with `compressed = 0`,
  the queue settles it — either in the slot before publication or under a fresh
  key after — and the row's url/size/mime follow), and the **bucket
  reconciliation** (a dry pass finds the flagless avatar candidate and changes
  nothing; a real pass repoints that avatar to a smaller new object and ledgers
  both keys; an unreferenced object and an object only a pasted link mentions
  come back byte-identical, the second counted as `skippedText`; a second dry
  pass reports zero candidates, which is the ledger doing its job; the admin
  payload carries the scan state). Skips without ffmpeg or Postgres. On Windows
  run it from Git Bash: `haveBinaries()` probes with `sh`, and a PowerShell
  session has no `sh` on PATH, so the scan-mode phase silently falls back to the
  no-engine path and its checks fail.
  `node scripts/test-compress-types.js` covers the compressor's **coverage
  contract** offline (no server, no database): that there is no size floor
  (`MIN_BYTES` all zero, so a 174-byte png / 300-byte mp4 / 2 KB wav are all
  candidates while a zip, a pdf, source code, an svg and an unidentifiable
  binary are not), that `planFor` routes every family — jpeg/png/gif/webp, the
  deferred `still` plan for BMP/TIFF/AVIF/JXL/HEIC/ICO by MIME *and* by name
  alone (the bucket scan's only evidence), any video container to mp4, any audio
  codec to mp3/m4a/ogg/webaudio, and neither `.ts` (TypeScript, not MPEG-TS) as
  video — and that every routed pipeline exists in `buildArgs`. Then the
  byte-level half: against real files it generates, `resolvePlan` sends a PNG to
  WebP (lossy by owner decision, and it checks the alpha channel survives that
  conversion), sends an opaque BMP/TIFF/AVIF/JXL to JPEG, and leaves a
  multi-frame APNG and animated WebP alone (a still re-encode would flatten
  them), with each resolved pipeline actually run on those bytes. It also checks the **knobs**
  in a child process (they are read at require time): concurrency defaults to 1
  and batch to 1, a configured pair is reported back, and both are clamped
  (4 encodes / 16 rows) and floored at one. Skips without ffmpeg/ffprobe.
  Re-run it after touching `planFor`/`resolvePlan`/`MIN_BYTES`/the env knobs in
  `media-compress.js`.
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
  menu's seven rows all carry an icon; the send key is exactly as tall as the
  one-line field — its height is `--field-h`, derived from the field's own
  padding + 1.5 line + border and restated for the phone's 16px field, so the two
  share a top and a bottom edge at both breakpoints (it used to be a flat 46px
  key, ~5px short of the box) — while staying one row tall, so a box grown to
  several lines keeps it on the bar; and it reads the box through
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
  skips its entry animation. It also covers the members drawer's own exit: the
  right-swipe twin (`swipeRightToClose`) drags the drawer out to the right and
  closes it past the threshold (a short drag springs back, a vertical or leftward
  drag is left to the list, and the release click is swallowed through the same
  shared window), and the capture-phase click listener, which is what stops the
  tap that dismisses the drawer from ALSO landing on the chat underneath — a tap
  outside closes it with no click reaching the control below, a tap inside is
  still the drawer's (and keeps it open), and the header (☰, the members button)
  is exempt.
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
  parks on the spinner forever. It also pins the deferral that keeps a backlog
  from starting a download per clip: the render path calls `requestVideoPoster`
  (an IntersectionObserver with a 320px margin) rather than `ensureVideoPoster`.
  `node scripts/test-image-previews.js` covers the derived chat-image previews
  (`thumbs/files/<name>.<ext>.webp`, see `AGENTS.md`/`media-compress.js`) — the
  fix for "the backlog of messages loaded when you open a chat takes a while",
  since one photo is 10-30x its own 640px WebP. Offline it runs the real
  `thumbKeyFor`/`thumbSourceKey` out of `media-compress.js` (the key round-trips,
  and anything that is not a chat still image is refused — `viewonce/` above all,
  which is gated behind a ticket and must have no side door) and checks the
  wiring statically: the server mints with a bounded wait and 404s uncached when
  it is not ready, the scan gate reads a preview through to its source (a
  preview of a pending/infected upload is the same bytes), deleting an upload
  takes its preview, the orphan sweep neither lists nor keeps one, the bucket
  scan queues the backfill for the worker to drain, and the client asks for the
  preview with the original one error away. Then, in headless Chrome, the REAL
  `attachmentHTML` plus the REAL document error handler against a server that
  404s one preview and serves another: the cold image lands on the original
  after exactly one fallback request (never the broken-file card), and the warm
  one never fetches the original at all. The lightbox keeping the original is
  asserted too — a preview in a full-screen viewer would be a visible downgrade.
  Re-run it after touching `messages.js`'s attachment markup, `final.js`'s error
  handler, `pickers.js`'s lightbox call, or the preview helpers.
  `node scripts/test-image-previews-e2e.js` is the same feature end-to-end
  (ffmpeg + Postgres, skipping without either; boots the cluster's shape —
  `VIRUS_SCAN=0`, compression on): a real upload's preview is minted on the
  first request as genuine WebP bytes far smaller than the upload, served from
  the bucket tree afterwards, refused for a missing source / a video / a
  non-image / a `viewonce/` key, never upscaled past a 64px source, absent from
  a dry orphan sweep while a planted unreferenced file is listed, and gone from
  disk (with the upload) when the message is deleted. Re-run after touching
  `media-compress.js`'s thumbnail block, `server.js`'s `/uploads/thumbs` route
  or `storage-sweep.js`'s listing.
  `node scripts/test-gif-favorites.js` covers starring a GIF somebody shared in
  chat into the GIF picker's favorites (the picker's own tiles could already
  write that list, but a posted GIF was only bytes with an opaque Klipy CDN url —
  nothing in it leads back to the item, so the picker now stamps the Klipy
  identity on the attachment it sends, the server validates and stores it, and
  the chat draws a star on that GIF). A GIF posted BEFORE that stamping existed
  is still starrable: it has no slug, but the md.gif url it was posted with is a
  stable identity of its own, so the client keys the favorite on a deterministic
  hash of that url (which the favorites route accepts as a slug) and every lookup
  matches by key OR by the gif itself — so the same GIF starred from chat and
  then from a picker tile is one row, never two. Offline it runs the real
  `cleanGifMeta` and the real key helpers out of `messages.js` (a remote GIF with
  no slug gets a stable key; an UPLOADED .gif and a non-GIF remote picture get
  none, because the favorites route would refuse their url) plus the two real
  writers sliced out of `pickers.js`: a star on a chat GIF and a picker tile must
  POST byte-identical bodies for the same GIF, and un-starring is one DELETE by
  slug. Headless Chrome then renders the REAL `attachmentHTML` against
  `styles.css`: the star is on a starrable GIF and nowhere else, it carries the
  whole favorite in its `data-*` attributes, it sits beside the download button
  in the picture's top-right corner with enough gap that the two 44px thumb boxes
  cannot overlap, the two are a matched PAIR (same 32px box, 10px rounding,
  scrim, reveal and press — the download button is a rounded square, not the old
  circle), it waits for the hover on a mouse device, and its "on" state is
  the account's list — by slug, by url key, or via a row the picker wrote under
  the real slug. It also pins the download button's OTHER life: the audio player
  and the text/code card reuse the same class inline, and the overlay geometry
  (absolute, opacity 0, no `.att-wrap` to hover) left that copy invisible at the
  top-right of the PAGE on a mouse device and pinned to the viewport on touch —
  measured, so the test asserts it is `position:static`, visible, and inside its
  own card, and that only the overlay copy grows a thumb hit box.
  Finally a real server against a throwaway database (skipping
  without Postgres) proves the round trip: the identity survives post → history
  for a channel AND a DM, a local upload or a bogus slug never keeps one, a
  favorite written from what the server handed a reader lands in that account's
  list and never in another's, re-starring the same GIF updates the one row, a
  pre-deploy GIF with no identity at all is starrable off its url alone, and the
  routes refuse a junk slug / a non-http gif / an unauthenticated caller. Re-run
  it after touching `cleanGifMeta`, `attWire`, the attachment inserts, `sendGif`,
  `attFavHTML`/`gifFavKeyFor`, the `.att-star` rules, or the gif-favorites
  routes.
  `node scripts/test-upload-cards.js` covers the composer's upload cards
  (headless Chrome, skipping without Chrome; it runs the REAL upload block sliced
  out of `messages.js` against a fake XMLHttpRequest, then checks the wiring
  statically) — the two reported bugs: a progress card that "moves servers with
  me" when you switch chats, and an upload that sits "stuck at 99%". An
  attachment and its upload are per conversation (`pendingByCtx` /
  `syncPendingAttsCtx`, re-synced by every `renderComposerMeta` plus explicit
  calls in selectChannel / selectServer / selectDmThread / renderDmBlank): the
  card only paints in the chat it was started in, a file that finishes after the
  reader moved on is PARKED for that conversation (and taken back when it is
  opened again) instead of becoming a chip in the wrong composer, two chats can
  upload at once without mixing, the 5-per-message cap counts one conversation,
  and an attach with no conversation is refused rather than orphaned. For the
  stuck card: the bar goes indeterminate and reads "Finishing…" once the browser
  has handed the whole body to the socket (a frozen 99% is what read as a hang),
  an upload watchdog turns a response that never comes into a normal failed card
  with Retry (armed from the send, and shortened to 90 s once the body is out —
  see `scripts/test-upload-stall.js` for the ceilings themselves), and every exit
  clears it. It also pins the two owner-reported follow-ups on that card: the
  readout no longer prints a bare "…" while the bar is indeterminate (it read as
  a "more options" menu button next to the ✕, so the % cell goes empty), and the
  chip's **Spoiler** toggle is held back while any upload for the conversation is
  still in flight — it appears only once the green "done" card has finished its
  ~650ms exit (`activeUploadCount` in `renderComposerMeta`). Re-run it after
  touching `messages.js`'s upload block, `renderComposerMeta`, the conversation
  switchers, or the paths that leave a conversation. Anything that changes
  `storage.js`'s S3 client (its timeout/retry config is what stops a silent
  object store from holding an upload request open forever) wants the upload
  routes re-checked with `scripts/test-upload-pipeline.js`.
  `node scripts/test-attachment-gap.js` covers the distance between the composer
  and the attachment cards above it (headless Chrome, skipping without Chrome;
  it builds the real chat column from `index.html`'s markup + the real
  `styles.css` and MEASURES the gap at a desktop and a phone viewport, with and
  without the cards on screen). Both stages of an upload used to read as "quite
  far from the message box": `#attach-preview` / `#upload-list` sit above the
  always-reserved typing strip, so a full `.9rem` of composer padding was pure
  extra air. With a card on screen `#chat:has(#attach-preview:not(.hidden))
  #composer` drops it to `.25rem` (the strip still separates them, and it keeps
  its height, so nothing below the cards moves). Two traps it now guards: CSS
  **padding cannot go negative** (`calc(.9rem - var(--strip-h))` clamps to 0, so
  an overlap would need a negative MARGIN), and **a sibling combinator inside
  `:has()` never matches** (`#composer:has(~ #attach-preview)` passes
  `CSS.supports` yet matched nothing in Chrome 152 — the static half fails if
  that form comes back). Re-run it after touching the composer's padding,
  `--strip-h`, `#attach-preview`/`#upload-list`, or the order of those elements
  in `index.html`.
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
  Sections [10]-[13] cover the durable half against a fake `/api/unread`:
  `syncChanUnread` replaces the marks with the server's answer (a cold start
  with an empty cache paints the badge, a channel read elsewhere stops being
  unread, the open conversation is never handed a dot back, an unreachable
  server leaves the last paint alone), `markChannelRead` clears on the spot and
  stamps the watermark server-side (a burst in the open chat coalesces into one
  write, returning to the tab stamps the open channel), "Mark all as read" goes
  out as ONE whole-server request (a folder stamps each server it holds), and
  the `chan-read` push drops the mark without ever writing one back.
  `node scripts/test-chan-unread-durable.js` covers the server side of that
  (static wiring + the app-icon badge as a pure function, then a real server
  against a throwaway database; skips without Postgres): `/api/unread` answers
  the channels of the caller's servers with an unseen message, a fresh
  membership starts caught up at `joined_at` (never the history),
  `POST /api/channels/:chId/read` and `POST /api/servers/:id/read` are durable
  and push `chan-read` to the account's other devices (so reading on the phone
  clears the desktop), own / system / thread-reply messages never count, both
  read routes are auth- and membership-guarded (404 for an unknown channel),
  leaving forgets the read state so a rejoin is caught up again, and the
  first-boot seed is one-shot: dropping `channel_reads` on a live database and
  booting marks every existing membership caught up (an upgrade must not light
  up every channel that ever saw a message) while a message after it is unread
  and a second boot does not seed again.
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
  it while leaving a server outside it alone. Section [8] is the owner's bug
  end to end: a webhook writes into a channel of Delta while the client knows
  nothing about it, the local cache and the in-memory marks are wiped and the
  page reloaded — the rail badge and the channel dot come back from the DATABASE
  (a server with only local-only marks stays clean), the dot is visibly opaque,
  and opening that channel clears the badge for good (a second reload does not
  resurrect it).
  `node scripts/test-message-longpress.js` covers the other half of the same
  report — "long-pressing the left side of a message highlights the timestamp
  instead of opening the menu" (headless Chrome at a phone viewport with real
  touch events; skips without Postgres or Chrome). Offline it pins the
  stylesheet: the `@media (pointer:coarse)` block opts every part of a message
  out of native selection (`-webkit-touch-callout:none` + `user-select:none`)
  for the plain page, `html.standalone` and `html.wrapper-app` (the Tauri
  Android shell, which is NOT `display-mode: standalone` — the reason the rules
  never applied there), while leaving the Edit-message textarea selectable; the
  wrapper is also asserted to inherit the standalone body rules. In the browser
  it holds a real finger down on the row's LEFT PADDING (no text under it), on
  the timestamp, on the avatar and on the message body: each hold slides the
  message sheet up, never the desktop context menu, selects nothing
  (`window.getSelection()` stays empty), and the sheet carries Copy text so
  turning selection off costs nothing; a plain tap still does not leave a sheet
  behind.
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
  `node scripts/test-tab-spinner.js` covers the loading spinner for the settings
  rail and the admin console's tab panes (static checks plus a headless-Chrome
  run against the real markup + `styles.css`; skips without Chrome). The shared
  helper is `tabSpin`/`tabSpinWhile` (`core.js`), and the mark goes on the PANE
  the reader is looking at — never beside the tab button, which would be
  invisible on a phone, where picking a section hides the rail. So the test
  asserts the pane carries `.loading` and `aria-busy`, that its stale rows stand
  down (`display:none`) while a 26px accent-arc ring on the app's `up-spin`
  keyframes centres itself in a page-tall block, that the tab button carries no
  mark at all (and the `.set-tab-spin` element is gone from both core.js and the
  stylesheet), that a rejected pane clears it instead of parking on it, that the
  mark is a COUNT on a WeakMap (two overlapping loads of one pane cannot clear it
  when the first settles), and that the flash threshold keeps a fast answer from
  showing anything or disturbing the pane. Statically it pins which panes spin
  (settings: account / notifications / blocked / games / media; admin: all five)
  and that the synchronous Themes pane does not, plus the reduced-motion off
  switch.
  `node scripts/test-att-shape.js` covers the shape of a picture before its
  bytes (the "media attachments just uncollapse and appear" fix). Offline it
  drives the REAL `image-size.js` header parser against generated and crafted
  files — JPEG (SOF behind EXIF), PNG, GIF, WebP in all three bitstreams, BMP
  including a top-down negative height, plus a committed PNG through
  `dimsFromFile` — and, more importantly, against what it must REFUSE: a
  truncated file, a non-image, an empty head, a zero or absurd dimension, and
  AVIF (a wrong shape is worse than none, so anything unrecognised answers
  null). Statically it pins the record (`w`/`h` guarded columns on both
  attachment tables, the partial index the backfill selects on, the
  `db.LOCKS.attDims` key), the bounded newest-first leader-locked backfill
  (`att-dims.js`: ranged GET of just the head, non-images marked 0/0 without a
  read, one unreadable object never stopping the run), the upload route that
  measures what it just stored (buffer in S3 mode, file on disk otherwise) and
  the ingest that clamps a client-supplied pair, the placeholder/`ready`
  contract in `attachmentHTML`/`wireAttImage`/`pins.js`, and the stylesheet
  rules (`--att-max-h` per surface, `no-ar` neutral box, `:has(.file-card)`,
  reduced motion). In headless Chrome — against the real markup, the real
  stylesheet and REAL generated PNGs served over HTTP — it measures each case
  synchronously before any bytes can arrive and again after the load: the
  reserved box must equal the box the picture lands in at every shape
  (landscape, portrait, square, small, a 4000px panorama) and against both caps,
  a picture under the caps must not be scaled, an unmeasured one must show the
  neutral box and then take its real ratio, a warm second render must clear its
  placeholder, and a spoilered picture keeps its veil and blur. Skips without
  Chrome.
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
  neighbour's tap (the phone header only shows ☰ and the ⋯ overflow, so the count
  is small on purpose — the check is that the visible ones keep their boxes), and
  a fine pointer (desktop) pushes no history entry at all. The members drawer is
  reached the way a thumb reaches it now: the ⋯ sheet's own Members row (the
  header button itself is hidden on a phone) — and that row really opens the
  drawer, because the outside-click closer exempts `#sheet` the same way it
  exempts the header (without that the row's own click was read as "outside the
  drawer" and closed it again in the same tick).
  `node scripts/test-launch-keyboard.js` covers the launch rule "opening the app
  on a phone must not pop the keyboard" (headless Chrome at a phone viewport,
  skipping without Chrome; it runs the REAL guard sliced out of
  `js/native.js` and checks the wiring statically): the guard only arms on a
  coarse pointer, it refuses focus on a textarea/text input/contenteditable
  while armed, it leaves a button and a checkbox focusable (it is not a focus
  thief), a field the platform focused BEFORE the guard installed is released by
  the launch sweep, one real dispatched touch disarms it for the rest of the
  session (so the composer then focuses normally), and the guard is re-armed on
  the next document load. Re-run it after touching the guard block in
  `native.js` — and note that the pieces it protects are platform behavior
  (Android WebView first-focus, an Android focus restore, a bfcache/reload
  re-focus of the composer), so a regression here is invisible on a desktop
  browser.
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
  `node scripts/test-update-banner.js` covers the deploy notice that replaced
  the forced reloads (owner request: users were being surprised by them). It runs
  the REAL banner block sliced out of `public/js/final.js` against a DOM stub and
  a virtual clock, so "nothing reloads itself" is asserted rather than eyeballed:
  the first poll only records what the page is running, a newer release raises the
  banner (and `body.ub-open` so the shell pays for its height), sixty further
  polls and a whole simulated hour reload NOTHING, the 30-second timer and the
  reload-on-leaving-a-call are gone, the click is the only thing that reloads (and
  it flushes the composer drafts first, disables itself so a double click cannot
  fire twice), dismissing is honoured without nagging while a LATER release still
  speaks up, and in a voice call the copy warns and the button reads "Leave &
  update" instead of quietly ending the call. The second half pins the
  rolling-update rule — with `maxUnavailable: 1` two builds answer at once, so a
  release generation rather than the build fingerprint decides "newer": an OLDER
  pod mid-rollout raises nothing, a newer build still does, and booting on the old
  pod after a reload shows nothing — plus the static wiring (`/api/version` and
  the WS handshake carry `gen`, `app_releases` is claimed idempotently, `voice.js`
  contains no reload at all, the markup/ids, and the CSS that makes `#view-main`,
  `#left`, `#members`, `#vo-view`, `#story-view` and `#view-auth` pay for the
  strip). Offline, no browser. Re-run after touching `final.js`'s banner block,
  `voice.js`'s join/leave, `socket.js`'s hello, `/api/version`, or the banner CSS.
  `node scripts/test-update-banner-layout.js` measures the same banner's LAYOUT in
  a real browser (headless Chrome over CDP, skipping without Chrome). It lays the
  REAL markup out with the REAL stylesheet and asserts the one invariant the whole
  design rests on: the strip's real height equals `--ub-h`, the amount
  `body.ub-open` moves every full-height surface down by. It caught a real 3px
  clip — the two-line text block is taller than the 32px button, so deriving 3rem
  from padding + control was wrong, and the height is declared now. Also: the
  header/rail/sidebar/nav page all start BELOW the strip, the Update button and ✕
  are hittable at their centres at every size, nothing overflows, and the copy is
  a single ellipsised line (the in-call warning is asserted to be fully readable,
  not truncated) at 1100x700, 390x844, 844x390, and 320x568. Every case asserts
  `innerWidth` matches what was asked for — via CDP device metrics, because a
  Windows window cannot go below ~490px and a `--window-size=390` probe silently
  laid out at 490. `--shot out.png [--w 390 --h 844 --mobile --call]` writes a
  real PNG of any case, which is how the design was eyeballed. Re-run after any
  change to the banner CSS, its markup, or the copy in `final.js`.
  `node scripts/test-multi-replica.js` is the acceptance test for running more
  than one replica (see `deploy/civo/README.md` §11). It spawns TWO real
  `server.js` processes against one throwaway Postgres, pins a WebSocket client to
  each, and asserts every fan-out crosses replicas: a channel message each way,
  exactly once with no duplicate on the origin (which is what proves the bus is
  actually carrying it and the origin-skip is intact), a DM through `notifyUser`,
  voice rosters that can only be right if `voice_occupants` is shared, a WebRTC
  offer reaching a peer socket on the other process, join/leave propagation, a
  presence roster and a status flip crossing pods, the admin Online count
  including the other replica's sessions, the rate limiter counting across
  replicas instead of granting each its own quota, and game-activity beacons
  being shared — a beacon to replica A followed by one to replica B 40s later must
  credit that 40s of playtime, which a per-process map silently dropped (and a
  quit on one replica must clear the badge read on the other). Skips (exit 0)
  without Postgres; re-run after touching `bus.js`, `server.js`'s fan-out
  helpers/voice/presence/limiter/beacon paths, or `db.js`'s shared tables.
  `node scripts/test-bus.js` and `node scripts/test-leader-lock.js` cover the two
  primitives underneath it in isolation: the outbox bus (ordering, the rescue pass
  for a lower id that commits late, origin-skip, retention) and the Postgres
  advisory locks (`withLock` skipping rather than queueing, `withLockWait`
  blocking, `withKeyLock` per storage key). `scripts/bus-probe.js` and
  `scripts/lock-probe.js` are the manual two-terminal probes for a live cluster.
