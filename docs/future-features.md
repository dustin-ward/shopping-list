# Future features and design seams

These are roadmap suggestions, **not MVP implementation requirements**. Do not
create unused tables, integrations, background jobs, or UI for them now.

## 1. Recommended sequence

1. Use the completed MVP long enough to collect genuine purchase history.
2. Add transparent recurring-item suggestions using that history.
3. Add manual spending and receipt totals/line items.
4. Add receipt-image import and reviewed extraction.
5. Investigate particular store price sources and product matching; build one
   useful integration before designing a broad comparison service.

Manual spending could precede recommendations if budgeting becomes the priority.
Recommendations need no external services; price integrations have the greatest
external dependencies and maintenance uncertainty.

## 2. Recurring-item suggestions

### User experience

Offer **You usually buy eggs around now** with Add and Dismiss actions. Suggestions
must be optional and explainable, never automatically insert/check off items.
Suppress suggestions for items already active. Re-adding uses normal catalog/group
defaults and leaves quantity/note to the user unless later explicitly configured.

### Initial algorithm

- Use non-voided purchase timestamps grouped by stable catalog identity.
- Start only after enough evidence, for example four purchases/three intervals;
  treat this threshold as tunable rather than a hard product promise.
- Estimate cadence with a median of recent intervals, plus a spread/confidence
  measure. Sparse or highly irregular histories should not generate confident
  reminders.
- Handle multiple purchases on the same day deliberately so duplicates or a
  multi-store trip do not imply a near-zero buying interval.
- Suggest when time since the last purchase approaches the estimated interval.
- Support dismiss/snooze and exclude items the user does not want suggested.
- Use a configured household timezone for day-level behavior. Purchases remain
  stored in UTC.

Compute on demand first. Notifications or scheduled work can be introduced if
requested. Do not add an LLM/vector database for a problem initially solved with
simple date statistics.

### Limits and extension points

Buying is not consumption: stocking up, travel, seasonality, and changed household
size affect cadence. Free-text quantities are not reliable numeric signals.
Future normalized quantities and explicit purchase-date correction may improve
the model. Provide item merge/alias tooling before combining differently named
historical items; do not retroactively guess identity.

The MVP preserves stable catalog IDs, purchase timestamps, snapshots, and voids,
which are the useful foundations. Removed list entries are not purchases.

## 3. Spending and manual receipts

Start with a receipt's date, store, currency, and total; optionally enter line
items. A grocery total is useful even when no reliable item-level breakdown is
available. Do not pretend an aggregate total can be allocated precisely to eggs.

Later introduce migrations for concepts such as:

- Receipt: store, purchase date, currency, total, tax/discounts, import provenance.
- Receipt line: printed description, quantity/unit when known, amount, and an
  optional link to a catalog item and/or purchase.
- Purchase-to-receipt links: accommodate one shopping trip, multiple checked-off
  items, unmatched receipt products, and repeated buys of the same item.

Store monetary values as integer minor units with an explicit currency, not
floating point. Where currencies/unit prices require finer precision, define the
representation intentionally; do not silently assume every currency has two
decimal places. Preserve totals separately from optional line-item accounting.

A receipt import and a checklist completion must not double-count the same
spending/purchase. Add review/reconciliation and link existing purchases where
possible rather than inserting duplicate purchases automatically.

Cost tracking should support corrections with provenance. Avoid redefining old
purchase snapshots just because a receipt matcher changed its guess.

## 4. Receipt scanning and spending ingestion

Recommended flow:

1. Upload/capture an image or import a supported spending export.
2. Extract candidate date, store, total, and line items.
3. Show the original alongside editable extracted values and confidence hints.
4. Require review before committing structured spending data.
5. Link to known purchases/items; leave uncertain matches unresolved.

Prefer local extraction if it works well enough. External OCR services require
explicit consent about sending private household receipts off-host. Imports must
deduplicate source records and distinguish grocery spending from other charges.
Bank/card totals often cannot identify individual products.

Attachment storage, upload limits, file validation, safe filenames, storage quotas,
and consistent database-plus-attachment backups become necessary when images are
introduced. Keep files on a persistent volume, not embedded browser-only state.
Do not assume OCR is accurate enough for unreviewed accounting.

## 5. Price and sale integrations

### Validate data availability first

For the specific stores/region, investigate official APIs, permitted feeds,
exports, or other authorized sources. Check terms, geography, login requirements,
rate limits, freshness, and whether in-store versus online prices differ.

Do not promise universal grocery-store scraping or assume sources remain stable.
Do not circumvent authentication, access restrictions, or anti-bot controls.
Manual price entry is a reasonable fallback and can validate the comparison UI.

### User names are not products

`Eggs` does not uniquely identify a brand, count, grade, or package. Introduce
explicit store products and mappings from reusable items when this feature is
actually built. Capture package quantity, normalized units where feasible,
location, currency, observed time, source, and promotion conditions.

Compare like with like: unit price, package size, membership/loyalty requirements,
sale dates, stock status when available, and data freshness. Unknown/stale prices
must look unknown/stale, not like verified cheapest offers.

### Architecture seam

Introduce provider adapters returning normalized price observations with source
and time. Keep adapters separate from the shopping-list domain; integration
failures must never prevent normal list use. Schedule fetches only when needed,
with bounded retries, caching, and per-source limits.

Expose recommendations such as **Aldi appears cheaper for this matching product**
with evidence. Do not equate a generic store group with an online product ID.
Store groups remain useful linkage points, but regional branches/location and
provider-specific identifiers belong in later integration tables.

## 6. Other possible extensions

| Feature | What must change |
| --- | --- |
| Multiple lists | UI selection and list scoping; core rows already have list IDs |
| Individual accounts | Authentication, sessions, household membership, authorization, cache isolation |
| Offline edits | Durable command queue, idempotency, reconciliation, conflict UX; not a cache toggle |
| Push reminders | Device subscriptions, permission UX, scheduling, notification privacy |
| Barcode scan | Product identifiers, scanner permissions, and catalog/product mapping |
| Live push updates | SSE/WebSockets or change notifications; preserve revision/transaction semantics |
| Many households/replicas | Authorization and operational redesign; reconsider SQLite/deployment needs |

Adding accounts/public access requires revisiting the current assumption that
every reachable client is trusted. Cached household snapshots must be cleared or
isolated on logout/account changes; network restrictions alone no longer suffice.
