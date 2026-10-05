# Product specification

## 1. Goal and scope

Replace a phone notes checklist with a fast, shared shopping list. Optimize for
one-handed use in a store, flexible names, and minimal administration.

### MVP includes

- One shared list used by all authorized devices.
- Add and edit item names, optional quantity text, and notes.
- Create, rename, reorder, and archive arbitrary groups.
- Mark a group as a store or an ordinary category.
- Assign an entry to zero, one, or multiple groups.
- All items, individual group views, and an Ungrouped view.
- Check off purchases, undo them, and clear completed entries.
- Preserve purchase history from day one; provide a simple paginated history
  view, not analytics or receipt management.
- Name suggestions from previously used items and remembered group assignments.
- Cross-device updates and explicit handling of conflicting changes.
- Installable mobile web app and read-only offline viewing.
- Tailnet-only deployment, persistence, migrations, backup, and restore.

### Not in the MVP

- Accounts, invitations, permissions, multiple household administration, or
  attribution to individual people.
- Multiple-list UI, notifications, recurring schedules, or recommendations.
- Offline edits, background synchronization, or conflict merging.
- Prices, receipt totals/images, OCR, barcode scanning, or product matching.
- Numeric units, unit conversion, item synonyms, or catalog merging.
- Native mobile apps, cloud hosting, or public-internet access.

## 2. Core concepts

| Concept | Meaning | Example |
| --- | --- | --- |
| Reusable item | Stable identity used for re-add suggestions and future history analysis | Eggs |
| List entry | A particular shopping need, with its own quantity, note, and state | Eggs, 2 dozen, large |
| Group | A flexible label; may optionally represent a store | Aldi, Costco, Camping |
| Purchase | A historical completion of an entry | Bought eggs at Aldi at a particular time |

Do not use one mutable row for both the shopping checklist and purchase history.
An item can be purchased repeatedly over time without replacing older purchases.

## 3. Main interface

- Default view: All items, with each active entry shown once.
- Group selector: All items, user groups, and Ungrouped. A store view is just a
  group view, not an independent list.
- Prominent Add item field; quantity and note are optional details.
- Large, labeled checkboxes and an accessible edit action on each entry.
- Group badges where useful; a quantity is visible on the row; notes can be
  expanded so they do not overwhelm the checklist.
- Purchased section, collapsed by default, with a count, Undo actions, and
  **Clear N purchased**. Its contents follow the selected view's group filter.
- Secondary screens for group management and purchase history.
- Visible connection status and last successful synchronization time.

Target touch controls of at least 44 by 44 CSS pixels. Do not depend on hover,
swipes, or long-press for essential actions. Support keyboard navigation, readable
contrast, screen-reader labels, and narrow screens without horizontal scrolling.

Default ordering: active entries by added time, oldest first; purchased entries
by completion time, newest first. User group order is configurable. Item drag
sorting and alphabetical sort controls are deferred.

## 4. Adding and editing

### Add

1. Enter any nonempty item name; a predefined catalog is not required.
2. Offer suggestions from previous item names, but allow new names freely.
3. A recognized item starts with its remembered groups. In a specific group
   view, also include the selected group. A new item in All items starts ungrouped.
4. Allow group adjustments before saving. In the Ungrouped view, explicitly
   start with no groups rather than restoring defaults.
5. Quantity and note start blank; do not assume a previous purchase's values.
6. Save one active entry. If the same reusable item is already active, show
   **Already on the list** and offer to open that entry; do not silently duplicate
   it, increase its quantity, or overwrite it.

Submitting an addition saves the chosen groups as that reusable item's defaults
for the next addition. Adding a previously purchased item creates a new entry;
it does not reactivate the earlier purchase.

Names are displayed in the user's spelling, with surrounding whitespace trimmed.
Resolve reusable identities with a consistently normalized key: Unicode NFKC,
trim/collapse whitespace, and lowercase. Do not infer that `egg` and `eggs` are
the same item. Reject empty names after normalization.

Suggested validation limits: name 120 characters, quantity 80, note 1,000, group
name 80. Validate on both client and server; these are pragmatic defaults rather
than a product taxonomy.

### Edit

- Edit only active entries in the MVP.
- Saving group changes also updates that reusable item's defaults for future
  additions; it does not change historical entries or other existing entries.
- Changing a name resolves or creates the corresponding reusable item and
  rebinds this entry. Do not globally rename a catalog identity or relabel its
  earlier purchases. Reject a name change if it would duplicate an active item.
- Preserve unsaved form text on errors and conflicts.
- Remove an active entry with an explicit action. Removal is cancellation, not
  purchase, and must not contribute to future purchase recommendations.

## 5. Multi-group and store behavior

Example: one Eggs entry belongs to both Aldi and Costco.

- It appears once in All items and once in each store view.
- Checking it off from Aldi completes the same entry everywhere and records
  Aldi as the actual purchase store.
- Checking it off from All items or an ordinary category records an unknown
  store. Do not interrupt a fast check-off with a required store-selection dialog.
- The purchase store is distinct from the entry's eligible groups. Never claim
  it was bought at every assigned store.
- Purchased rows may show **Bought at Aldi**, even in the Costco view.
- Counts in All items are unique entries, not summed group memberships.

Groups of kind `category` are not treated as stores. Group names are unique
among non-archived groups under the same normalization rules. Group kind is
chosen at creation and is not editable in the MVP; rename and reorder remain
available. A later kind-conversion feature must address historical store links.

Archiving a group hides it from current views, defaults, and assignment controls,
but retains its historical references. An active entry with no remaining visible
groups appears in Ungrouped. If the currently selected group is archived on
another device, return to All items after synchronization.

## 6. Completion, undo, and history

### Purchase

Atomically mark the entry purchased and create a purchase record containing its
item identity, name, quantity, note, timestamp, and known store. Repeated or
concurrent completion requests must never create two valid purchases for one
completion. Server time is authoritative.

Purchased entries move into the collapsed Purchased section but remain linked
to their assigned groups. Other devices see the transition after synchronization.

### Undo

Undo is available on an unarchived purchased entry, including as a convenient
post-completion action. It restores the entry to active and marks that purchase
void; it does not hard-delete history. Completing it again creates a new record.

If a new active entry for the same reusable item already exists, reject undo
with a clear **This item is already active** message. Do not merge quantities or
overwrite that newer entry. The original purchase remains unchanged on failure.

### Clear purchased

Clear only the purchased entries shown in the current view at the time the user
invokes the action, using their IDs and revisions. Make that scope and count
explicit. Archive the entries; do not delete purchases.

Entries purchased by another device after that snapshot are not accidentally
cleared. If one of the targeted entries changed, reject the batch, refresh, and
ask the user to retry. The operation is atomic, not a partial silent success.

After clearing, the MVP does not expose undo in history. This keeps historical
correction/receipt editing outside the initial checklist scope.

### History

Provide a simple date-ordered, paginated online history view showing item,
quantity, timestamp, and known store. Mark voided purchases clearly if displayed;
the default view excludes them. Historical name and store snapshots remain
unchanged if names are later reused or a group is renamed/archived.

## 7. Collaboration and connectivity

- The server is authoritative; never save an entire client snapshot over the
  server's list.
- While visible, poll approximately every three seconds. Refresh immediately
  on opening, focus/resume, and reconnection. Suspend polling while hidden.
- Changes to the same entry are guarded by its revision. A stale edit produces
  a visible conflict, refreshed state, and an opportunity to retry deliberately.
- Changes to different entries can both succeed even if the overall list changed.
- Show an in-flight state and only confirm a save/check-off after server success.
  Do not present an unconfirmed operation as a completed purchase.
- Disable repeat submissions while pending. For ambiguous network failures,
  explain that the save is unconfirmed and refresh before allowing a deliberate
  retry. Never automatically replay a purchase after reconnecting.
- Reachability is based on successful server requests, not just
  `navigator.onLine`; internet access does not imply the tailnet app is reachable.
- Distinguish validation/conflict responses from connectivity failures. A
  rejected edit does not imply the device is offline.

## 8. Offline viewing

After a successful online visit, the installed/browser app can load its shell and
last-known list without reaching the home lab. Support All items, group switching,
Ungrouped, details, and expanding Purchased from the cached snapshot.

- Display **Offline — last refreshed [time]** prominently.
- Disable all server mutations: add, edit, remove, complete, undo, clear, and
  group changes. Do not queue changes.
- Historical purchases outside the cached current-list snapshot are online-only.
- First-ever offline launch, cleared browser storage, or evicted caches show a
  friendly **No saved list available; connect to load it** state.
- On reconnection, fetch a current snapshot before enabling edits.
- Provide a local **Clear this device's saved data** action. It affects only local
  caches, not the shared database.

Browser storage is best-effort and private to that browser installation. This is
not a server backup and cannot guarantee availability if iOS/Android evicts it.
Document that saved list data remains readable on the device until cleared.

## 9. Acceptance examples

1. Device A adds Eggs to Aldi and Costco with quantity `2 dozen`; device B sees
   one new entry and both group memberships.
2. Device B purchases Eggs in Aldi; it is purchased in both store views and the
   All items count falls by one. Exactly one valid purchase exists, at Aldi.
3. Two devices submit edits based on the same entry revision; the first succeeds
   and the other sees a conflict rather than overwriting it.
4. Two devices purchase the same entry concurrently; one transition succeeds,
   the other refreshes, and only one valid purchase is recorded.
5. Undo restores an entry and voids its purchase. Clear purchased preserves all
   valid historical purchases while removing only targeted completed rows.
6. Re-adding Eggs later creates a new entry with remembered groups, without
   mutating or deleting the earlier purchase.
7. After an online visit, airplane mode still allows opening and filtering the
   saved list. Purchase and edit controls are disabled and staleness is visible.
8. Replacing the app container preserves all server data. A restored database
   reproduces groups, entries, valid purchases, and voided purchases.
