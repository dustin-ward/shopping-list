import { z } from 'zod';
import { normalizeName } from './normalize';

const uuidSchema = z.uuid();
const itemNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(120, 'Names can be up to 120 characters.')
  .refine((name) => normalizeName(name).length > 0, 'Enter a name.');
const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a group name.')
  .max(80, 'Group names can be up to 80 characters.')
  .refine((name) => normalizeName(name).length > 0, 'Enter a group name.');
export const DEFAULT_GROUP_COLOR = '#d6a453';
const groupColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Choose a valid group color.');
const quantitySchema = z.string().max(80).nullable().optional();
const noteSchema = z.string().max(1000).nullable().optional();

const uniqueGroupIdsSchema = z
  .array(uuidSchema)
  .max(100)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'Group assignments must be unique.',
      });
    }
  });

const mutationBaseSchema = z.object({ serverInstanceId: uuidSchema });

export const addEntrySchema = mutationBaseSchema
  .extend({
    id: uuidSchema,
    name: itemNameSchema,
    quantityText: quantitySchema,
    note: noteSchema,
    groupIds: uniqueGroupIdsSchema,
  })
  .strict();

export const editEntrySchema = mutationBaseSchema
  .extend({
    expectedRevision: z.number().int().min(1),
    name: itemNameSchema,
    quantityText: quantitySchema,
    note: noteSchema,
    groupIds: uniqueGroupIdsSchema,
  })
  .strict();

export const purchaseEntrySchema = mutationBaseSchema
  .extend({
    expectedRevision: z.number().int().min(1),
    storeGroupId: uuidSchema.nullable().optional(),
  })
  .strict();

export const entryRevisionSchema = mutationBaseSchema
  .extend({ expectedRevision: z.number().int().min(1) })
  .strict();

export const archiveEntriesSchema = mutationBaseSchema
  .extend({
    entries: z
      .array(
        z
          .object({ id: uuidSchema, expectedRevision: z.number().int().min(1) })
          .strict(),
      )
      .min(1)
      .max(200)
      .superRefine((entries, ctx) => {
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Entry IDs must be unique.',
          });
        }
      }),
  })
  .strict();

export const createGroupSchema = mutationBaseSchema
  .extend({
    name: groupNameSchema,
    kind: z.enum(['store', 'category']),
    color: groupColorSchema.default(DEFAULT_GROUP_COLOR),
  })
  .strict();

export const renameGroupSchema = mutationBaseSchema
  .extend({
    expectedRevision: z.number().int().min(1),
    name: groupNameSchema,
    color: groupColorSchema.optional(),
  })
  .strict();

export const reorderGroupsSchema = mutationBaseSchema
  .extend({
    groups: z
      .array(
        z
          .object({
            id: uuidSchema,
            expectedRevision: z.number().int().min(1),
            position: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .max(100)
      .superRefine((groups, ctx) => {
        if (new Set(groups.map((group) => group.id)).size !== groups.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Group IDs must be unique.',
          });
        }
        if (
          new Set(groups.map((group) => group.position)).size !== groups.length
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Group positions must be unique.',
          });
        }
      }),
  })
  .strict();

export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    list: z.object({ id: uuidSchema, name: z.string() }),
    revision: z.number().int().min(0),
    serverInstanceId: uuidSchema,
    groups: z.array(
      z.object({
        id: uuidSchema,
        name: z.string(),
        kind: z.enum(['store', 'category']),
        color: groupColorSchema.default(DEFAULT_GROUP_COLOR),
        position: z.number().int().min(0),
        revision: z.number().int().min(1),
      }),
    ),
    catalogItems: z.array(
      z.object({
        id: uuidSchema,
        name: z.string(),
        defaultGroupIds: z.array(uuidSchema),
      }),
    ),
    entries: z.array(
      z.object({
        id: uuidSchema,
        catalogItemId: uuidSchema,
        name: z.string(),
        quantityText: z.string().nullable(),
        note: z.string().nullable(),
        status: z.enum(['active', 'purchased']),
        revision: z.number().int().min(1),
        createdAt: z.string(),
        completedAt: z.string().nullable(),
        groupIds: z.array(uuidSchema),
        purchase: z
          .object({
            id: uuidSchema,
            purchasedAt: z.string(),
            storeGroupId: uuidSchema.nullable(),
            storeNameSnapshot: z.string().nullable(),
          })
          .nullable(),
      }),
    ),
  })
  .strict();

export const purchaseHistoryPageSchema = z.object({
  items: z.array(
    z.object({
      id: uuidSchema,
      name: z.string(),
      quantityText: z.string().nullable(),
      purchasedAt: z.string(),
      storeName: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const receiptStatusSchema = z.enum([
  'pending',
  'processing',
  'review',
  'committed',
  'discarded',
  'failed',
]);

export const receiptQuantityUnitSchema = z.enum([
  'lb',
  'kg',
  'oz',
  'g',
  'l',
  'ml',
  'ea',
]);

export const receiptReviewStateSchema = z.enum([
  'unreviewed',
  'bound',
  'new',
  'unknown',
  'skipped',
]);

/**
 * One row of the Receipts tab list. Money stays in minor units; `currency` is
 * only a display hint, never a per-receipt conversion.
 */
export const receiptListItemSchema = z.object({
  id: uuidSchema,
  status: receiptStatusSchema,
  createdAt: z.string(),
  capturedAt: z.string().nullable(),
  currency: z.string().nullable(),
  totalMinor: z.number().int().nullable(),
  storeGroupId: uuidSchema.nullable(),
  imageAvailable: z.boolean(),
  hasUnknowns: z.boolean(),
  lastError: z.string().nullable(),
});

export const receiptListPageSchema = z.object({
  items: z.array(receiptListItemSchema),
  nextCursor: z.string().nullable(),
});

/**
 * The binding provenance values in the order the telemetry surface shows them.
 * One shared order stops the server's buckets, the client's shares, and the
 * component's rows from drifting apart.
 */
export const RECEIPT_BOUND_VIA_VALUES = [
  'auto',
  'suggested',
  'manual',
  'created',
] as const;

export const receiptBoundViaSchema = z.enum(RECEIPT_BOUND_VIA_VALUES);

export const receiptLineSchema = z.object({
  id: uuidSchema,
  lineIndex: z.number().int().min(0),
  rawText: z.string(),
  parsedName: z.string().nullable(),
  quantityReal: z.number().nullable(),
  quantityText: z.string().nullable(),
  quantityUnit: receiptQuantityUnitSchema.nullable(),
  unitPriceMinor: z.number().int().nullable(),
  totalPriceMinor: z.number().int().nullable(),
  isItemChunk: z.boolean(),
  confidence: z.number().nullable(),
  catalogItemId: uuidSchema.nullable(),
  reviewState: receiptReviewStateSchema,
  boundVia: receiptBoundViaSchema.nullable(),
  boundRank: z.number().int().nullable(),
});

/**
 * One candidate the matcher offers for a receipt line. Tier 1 is a normalized
 * exact match to an item name or a human-confirmed alias (the line arrives
 * bound on it); tier 2 is a fuzzy suggestion, never auto-bound. `score` is a
 * ranking number, not a probability.
 */
export const receiptSuggestionSchema = z.object({
  catalogItemId: uuidSchema,
  name: z.string(),
  tier: z.union([z.literal(1), z.literal(2)]),
  score: z.number(),
  /** A human-confirmed alias for this item was learned at this receipt's store. */
  sameStore: z.boolean(),
});

export const receiptDetailLineSchema = receiptLineSchema.extend({
  /** Ranked candidates for this line, ≤5; empty on a parked row. */
  suggestions: z.array(receiptSuggestionSchema),
});

/**
 * Why a parse is worth a second reading, or `lowConfidence: false` when it is
 * not. Derived from the stored lines and warnings on every read — it is a
 * function of the parse, not another column. `helperApplied` stops the review
 * screen from offering the same helper again on its own output.
 */
export const receiptParseQualitySchema = z.object({
  lowConfidence: z.boolean(),
  helperApplied: z.boolean(),
  /** Short, reviewer-facing fragments ("no price column was found"). */
  reasons: z.array(z.string()),
});

export const receiptDetailSchema = receiptListItemSchema.extend({
  updatedAt: z.string(),
  processedAt: z.string().nullable(),
  committedAt: z.string().nullable(),
  subtotalMinor: z.number().int().nullable(),
  taxMinor: z.number().int().nullable(),
  parseVersion: z.number().int(),
  attempts: z.number().int(),
  ocrWarnings: z.string().nullable(),
  /** Raw OCR line text joined with newlines; null until the receipt is processed. */
  ocrText: z.string().nullable(),
  /** Null until the receipt has been parsed at least once. */
  parseQuality: receiptParseQualitySchema.nullable(),
  lines: z.array(receiptDetailLineSchema),
});

export const receiptCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  /** `RECEIPT_HELPER_URL` set: the re-parse affordance can be offered. */
  helperEnabled: z.boolean(),
  currency: z.string(),
});

/**
 * One learned alias: the printed wording a catalog item answers to. A row is
 * per list and soft-deleted (`deletedAt`) — a deleted alias stops auto-binding
 * while the row stays queryable as the audit trail of what was once confirmed
 * (plan §7, `ADR 0003`).
 */
export const aliasSourceSchema = z.enum(['manual', 'review', 'auto']);

export const itemAliasSchema = z.object({
  id: uuidSchema,
  /** The printed variant, e.g. `DAIRYLAND 2% 1L`. */
  aliasText: z.string(),
  normalizedAlias: z.string(),
  source: aliasSourceSchema,
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

/** One item's aliases — live and deleted — as the alias surface lists them. */
export const itemAliasesSchema = z.object({
  catalogItemId: uuidSchema,
  name: z.string(),
  aliases: z.array(itemAliasSchema),
});

/**
 * A phrase two or more items claim, so tier 1 refuses to bind it and the
 * reviewer is asked instead of guessed at (`ADR 0003`). `phrase` is the printed
 * wording to show; `normalizedPhrase` is what the claims share.
 */
export const ambiguousPhraseSchema = z.object({
  phrase: z.string(),
  normalizedPhrase: z.string(),
  items: z.array(z.object({ catalogItemId: uuidSchema, name: z.string() })),
});

/** `GET /api/aliases`: every learned alias, grouped per item, plus ambiguities. */
export const aliasOverviewSchema = z.object({
  items: z.array(itemAliasesSchema),
  ambiguous: z.array(ambiguousPhraseSchema),
});

/**
 * One wording the household could not identify (ticket 17; plan §13 "R2 —
 * matching maturity": the unknown-line grouped browser). Every committed item
 * line the reviewer marked unknown whose printed text normalizes the same joins
 * one group, so the group's count and money are the unidentified spending for
 * that wording — and binding the wording resolves every constituent line.
 * `printedText` is the most recently committed printing, which is the wording
 * shown and the one an alias is learned from.
 */
export const unknownLineGroupSchema = z.object({
  normalizedText: z.string(),
  printedText: z.string(),
  lineCount: z.number().int().min(1),
  receiptCount: z.number().int().min(1),
  spendMinor: z.number().int(),
});

/** `GET /api/unknown-lines`: the unidentified-spending view. */
export const unknownLinesOverviewSchema = z.object({
  currency: z.string(),
  groups: z.array(unknownLineGroupSchema),
  lineCount: z.number().int().min(0),
  spendMinor: z.number().int(),
});

/**
 * `POST /api/unknown-lines/bind`: bind one grouped wording to an item. The
 * group is named by its normalized text — the key the browser reads — and the
 * server binds only the committed unknown lines that still carry that phrase.
 * The empty string names the group of lines with no printed wording; those
 * lines bind but teach no alias.
 */
export const unknownLinesBindSchema = z
  .object({
    normalizedText: z.string().trim().max(300),
    catalogItemId: uuidSchema,
  })
  .strict();

/** The fresh view after a bind, plus how many lines it changed. */
export const unknownLinesBindResultSchema = z.object({
  overview: unknownLinesOverviewSchema,
  boundLineCount: z.number().int().min(0),
});

/**
 * Everything one canonical item currently owns (ticket 19). The counts are the
 * audit trail of a merge: a canonical item is the identity that list entries,
 * receipt lines, purchases and aliases attach to, so moving one item into
 * another must account for every row, and an admin surface can only claim
 * "nothing was lost" if it says how many rows it started and ended with.
 *
 * `committedReceiptLines` is the subset of `receiptLines` that is price history;
 * `activeListEntries` is the subset of `listEntries` the one-active-entry-per-
 * item rule constrains.
 */
export const itemReferenceCountsSchema = z.object({
  receiptLines: z.number().int().min(0),
  committedReceiptLines: z.number().int().min(0),
  purchases: z.number().int().min(0),
  liveAliases: z.number().int().min(0),
  deletedAliases: z.number().int().min(0),
  listEntries: z.number().int().min(0),
  activeListEntries: z.number().int().min(0),
  categoryMemberships: z.number().int().min(0),
});

/** One item as the management surface lists it: the household term and its footprint. */
export const itemSummarySchema = z.object({
  id: uuidSchema,
  name: z.string(),
  counts: itemReferenceCountsSchema,
});

/** `GET /api/items`: the canonical items of this list, alphabetical, with counts. */
export const itemOverviewSchema = z.object({
  items: z.array(itemSummarySchema),
});

/**
 * `PATCH /api/items/[id]`: rename the household term.
 *
 * `expectedName` is the display name the caller last saw — the catalogue has no
 * per-row revision, and the name is what the snapshot shows — so a rename from a
 * stale view refuses instead of overwriting a newer term. Only `display_name`
 * and `normalized_name` move: printed variants (`receipt_lines.raw_text`,
 * `parsed_name`) and aliases are untouched, exactly as `ADR 0003` requires.
 */
export const renameItemSchema = z
  .object({
    serverInstanceId: uuidSchema,
    expectedName: itemNameSchema,
    name: itemNameSchema,
  })
  .strict();

/** `POST /api/items/[id]/merge`: `[id]` is the absorbed item. */
export const mergeItemsSchema = z
  .object({
    serverInstanceId: uuidSchema,
    survivorId: uuidSchema,
    expectedName: itemNameSchema,
    expectedSurvivorName: itemNameSchema,
  })
  .strict();

/** The renamed item, plus how many visible list entries adopted the new term. */
export const renameItemResultSchema = z.object({
  serverInstanceId: uuidSchema,
  revision: z.number().int().min(0),
  item: z.object({ id: uuidSchema, name: z.string() }),
  renamedEntryCount: z.number().int().min(0),
});

/**
 * The merge's audit report: the two items and their reference counts before and
 * after the one transaction, plus the alias and membership bookkeeping that
 * explains the differences. The server computes every "after" count from the
 * database, not from arithmetic, and refuses the merge if the totals do not
 * reconcile.
 */
export const mergeItemsResultSchema = z.object({
  serverInstanceId: uuidSchema,
  revision: z.number().int().min(0),
  survivor: z.object({ id: uuidSchema, name: z.string() }),
  absorbed: z.object({ id: uuidSchema, name: z.string() }),
  before: z.object({
    survivor: itemReferenceCountsSchema,
    absorbed: itemReferenceCountsSchema,
  }),
  after: z.object({
    survivor: itemReferenceCountsSchema,
    absorbed: itemReferenceCountsSchema,
  }),
  /** Absorbed alias rows re-pointed at the survivor (deleted ones included). */
  aliasesMoved: z.number().int().min(0),
  /** Absorbed live aliases soft-deleted because the survivor already claimed the phrase. */
  aliasesRetired: z.number().int().min(0),
  /** A new alias row teaching the absorbed household term to the survivor. */
  aliasesLearned: z.number().int().min(0),
  /** A soft-deleted survivor alias revived for the absorbed household term. */
  aliasesRevived: z.number().int().min(0),
  /** Absorbed category memberships the survivor already had. */
  membershipsDropped: z.number().int().min(0),
});

/**
 * One binding source's share of the committed item lines (ticket 18; plan §7
 * "Learning loop": binding provenance recorded since R1 feeds suggestion
 * telemetry). `lineCount` is a count, not a percentage, because the surface that
 * shows a share can divide by the total it already has and the API stays exact.
 */
export const matchingSourceStatSchema = z.object({
  source: receiptBoundViaSchema,
  lineCount: z.number().int().min(0),
});

/** One accepted suggestion rank, counted among the lines bound via `suggested`. */
export const matchingRankStatSchema = z.object({
  rank: z.number().int().min(1),
  lineCount: z.number().int().min(1),
});

/**
 * `GET /api/matching-stats`: the read-only evidence base for later scoring or
 * embedding work (ticket 18). The scope is committed receipts of this list and
 * their item lines; parked rows are not purchased things and belong to no
 * binding. The four `sources` are always present in canonical order, even at
 * zero, and `noBindingLineCount` is the residual — committed item lines that
 * were marked unknown or skipped, or that carry no provenance — so
 * `sum(sources) + noBindingLineCount` reconciles with `lineCount`.
 */
export const matchingStatsSchema = z.object({
  committedReceiptCount: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  noBindingLineCount: z.number().int().min(0),
  sources: z.array(matchingSourceStatSchema),
  suggested: z.object({
    /** Lines bound via `suggested`, the denominator of the rank distribution. */
    lineCount: z.number().int().min(0),
    /** Only ranks that were actually accepted, ascending. */
    ranks: z.array(matchingRankStatSchema),
    /** Accepted suggestions stored without a rank, so the distribution reconciles. */
    unrankedLineCount: z.number().int().min(0),
  }),
});

/**
 * The measurement families price history compares within (ticket 20; plan §8
 * "Prices API"). Normalization never crosses one: a pound has no meaning in the
 * count family and no density is assumed between mass and volume.
 */
export const priceFamilySchema = z.enum(['mass', 'volume', 'count']);
export const PRICE_FAMILY_VALUES = priceFamilySchema.options;

/** The one comparison unit each family normalizes to: per kg, per litre, per each. */
export const priceBaseUnitSchema = z.enum(['kg', 'l', 'ea']);

/**
 * "Simple trend" is the direction between the two most recent comparable points
 * in one family; `unknown` when the family has fewer than two.
 */
export const priceTrendSchema = z.enum(['up', 'down', 'flat', 'unknown']);

/**
 * One committed line's normalized contribution to the price history. The amount
 * actually paid (`totalPriceMinor`) is kept beside the normalized per-unit price
 * because spend and per-unit comparisons answer different questions: a line
 * whose unit cannot be normalized still contributes to what was spent.
 */
export const itemPricePointSchema = z.object({
  receiptId: uuidSchema,
  lineId: uuidSchema,
  /** The receipt's `created_at` — the authoritative record time. */
  receiptCreatedAt: z.string().trim().min(1).max(40),
  /** The printed variant this point came from. */
  printedText: z.string(),
  quantityReal: z.number().nullable(),
  quantityUnit: receiptQuantityUnitSchema,
  totalPriceMinor: z.number().int().nullable(),
  /** The line price per the family's base unit, not per its printed unit. */
  normalizedUnitPriceMinor: z.number().int(),
});

/**
 * One family's comparison series inside one store, oldest point first. Only
 * lines that could be normalized appear here; `min`/`max`/`last` are therefore
 * always within a single family.
 */
export const itemPriceFamilySchema = z.object({
  family: priceFamilySchema,
  unit: priceBaseUnitSchema,
  lineCount: z.number().int().min(0),
  lastUnitPriceMinor: z.number().int(),
  minUnitPriceMinor: z.number().int(),
  maxUnitPriceMinor: z.number().int(),
  trend: priceTrendSchema,
  history: z.array(itemPricePointSchema),
});

/**
 * One store group's price history for an item. `spendMinor` and `lineCount`
 * cover every committed line at the store; `families` covers only the lines
 * whose units could be compared. `lastPaid*` names the most recent line's
 * amount (not a unit price) and its source receipt — a store row is always
 * derived from at least one line.
 */
export const itemStorePricesSchema = z.object({
  storeGroupId: uuidSchema,
  storeName: z.string(),
  lineCount: z.number().int().min(0),
  spendMinor: z.number().int(),
  lastPaidMinor: z.number().int().nullable(),
  lastPaidAt: z.string().trim().min(1).max(40),
  lastReceiptId: uuidSchema,
  families: z.array(itemPriceFamilySchema),
});

/**
 * `GET /api/items/[catalogItemId]/prices`: price history derived from committed
 * receipt lines of this item, per store group (ticket 20). Stores are newest
 * receipt first; an item with no committed history answers an empty `stores`
 * list rather than an error. Currency is the configured receipt currency —
 * multi-currency is out of scope (spec §9).
 */
export const itemPricesSchema = z.object({
  catalogItemId: uuidSchema,
  itemName: z.string(),
  currency: z.string().trim().length(3),
  receiptCount: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  spendMinor: z.number().int(),
  stores: z.array(itemStorePricesSchema),
});

/**
 * One line's review edits. Every field is optional: the editor sends what the
 * reviewer touched and nothing else, so two edits of the same line never fight
 * over fields neither of them changed.
 */
export const receiptLineEditSchema = z
  .object({
    id: uuidSchema,
    rawText: z
      .string()
      .trim()
      .min(1, 'Printed text cannot be empty.')
      .max(300, 'Printed text can be up to 300 characters.')
      .optional(),
    quantityReal: z
      .number()
      .gt(0, 'Quantity must be more than zero.')
      .nullable()
      .optional(),
    quantityText: z.string().trim().max(80).nullable().optional(),
    quantityUnit: receiptQuantityUnitSchema.nullable().optional(),
    unitPriceMinor: z.number().int().nullable().optional(),
    totalPriceMinor: z.number().int().nullable().optional(),
    reviewState: receiptReviewStateSchema.optional(),
    catalogItemId: uuidSchema.nullable().optional(),
    boundVia: receiptBoundViaSchema.nullable().optional(),
    boundRank: z.number().int().min(1).nullable().optional(),
  })
  .strict();

/** `PATCH /api/receipts/[id]`: the review edits, guarded by `updated_at`. */
export const updateReceiptSchema = z
  .object({
    /** The receipt's `updatedAt` the editor last saw. */
    expectedUpdatedAt: z.string().trim().min(1).max(40),
    lines: z
      .array(receiptLineEditSchema)
      .max(1000)
      .superRefine((lines, ctx) => {
        if (new Set(lines.map((line) => line.id)).size !== lines.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Line IDs must be unique.',
          });
        }
      })
      .optional(),
    storeGroupId: uuidSchema.nullable().optional(),
    currency: z.string().trim().length(3).optional(),
    subtotalMinor: z.number().int().nullable().optional(),
    taxMinor: z.number().int().nullable().optional(),
    totalMinor: z.number().int().nullable().optional(),
  })
  .strict();

/**
 * `POST /api/receipts/[id]/reparse`: hand the receipt's immutable OCR evidence
 * to the fallback helper and replace the parsed lines. Guarded by the
 * `updatedAt` the reviewer last saw, like every other review write, because the
 * replacement discards any lines edits made since.
 */
export const reparseReceiptSchema = z
  .object({
    expectedUpdatedAt: z.string().trim().min(1).max(40),
  })
  .strict();

/**
 * `POST /api/receipts/[id]/commit`: the reviewer's commit, guarded by the
 * receipt's `updated_at` like every other review write.
 *
 * The two draft kinds travel here and only here: a name the reviewer gave an
 * inline-created item (there is no column a draft could live in, and nothing is
 * created before commit) and a drafted store name (which stands in place of a
 * chosen group — one of the two can be set, never both).
 */
export const commitReceiptSchema = z
  .object({
    expectedUpdatedAt: z.string().trim().min(1).max(40),
    itemDrafts: z
      .array(z.object({ lineId: uuidSchema, name: itemNameSchema }).strict())
      .max(1000)
      .superRefine((drafts, ctx) => {
        if (
          new Set(drafts.map((draft) => draft.lineId)).size !== drafts.length
        ) {
          ctx.addIssue({
            code: 'custom',
            message: 'Line IDs must be unique.',
          });
        }
      })
      .optional(),
    /** A store the reviewer created inline, instead of choosing an existing one. */
    storeDraft: groupNameSchema.optional(),
  })
  .strict();

/**
 * The states a repair can leave a committed line in. `unreviewed` is not one of
 * them: a committed receipt's item lines have all been decided, and handing one
 * back to the commit gate would ask a question the receipt has already answered.
 */
export const receiptRepairStateSchema = z.enum(['bound', 'unknown', 'skipped']);

/**
 * One committed line's repair: the binding half of a review edit and nothing
 * else. The printed text, quantities, prices, store, `ocr_json` and the image
 * stay exactly as committed — a repair moves the binding, never a raw artifact —
 * and `display_name` is never rewritten (`ADR 0003`). Naming an item is naming
 * the state, exactly as the review contract requires.
 *
 * Provenance is narrower than the review contract's: a repair is a human act, so
 * it can record a pick (`manual`) or an accepted chip (`suggested`) and nothing
 * else — `auto` would dress a correction up as the matcher's own work, and
 * `created` names a draft a committed receipt no longer has. A line the repair
 * leaves on the item it already sits on keeps the provenance it was committed
 * with; only what the patch itself names is checked here.
 */
export const receiptRepairLineSchema = z
  .object({
    id: uuidSchema,
    reviewState: receiptRepairStateSchema.optional(),
    catalogItemId: uuidSchema.nullable().optional(),
    boundVia: z.enum(['manual', 'suggested']).nullable().optional(),
    boundRank: z.number().int().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (line) =>
      line.reviewState !== undefined || line.catalogItemId !== undefined,
    { message: 'A repair names the state or the item it corrects.' },
  );

/**
 * `POST /api/receipts/[id]/repair`: the explicit repair mode for a committed
 * receipt, a route of its own rather than a flag on the review `PATCH` (which
 * stays review-only). Guarded by the receipt's `updated_at`, the same guard
 * every review write carries.
 */
export const repairReceiptSchema = z
  .object({
    expectedUpdatedAt: z.string().trim().min(1).max(40),
    lines: z
      .array(receiptRepairLineSchema)
      .min(1)
      .max(1000)
      .superRefine((lines, ctx) => {
        if (new Set(lines.map((line) => line.id)).size !== lines.length) {
          ctx.addIssue({
            code: 'custom',
            message: 'Line IDs must be unique.',
          });
        }
      }),
  })
  .strict();

/** `POST /api/receipts`: 201 for a new capture, 200 for a deduplicated one. */
export const receiptUploadResponseSchema = z.object({
  id: uuidSchema,
  status: receiptStatusSchema,
  alreadyCaptured: z.boolean().optional(),
});

export type AddEntryInput = z.infer<typeof addEntrySchema>;
export type EditEntryInput = z.infer<typeof editEntrySchema>;
export type PurchaseEntryInput = z.infer<typeof purchaseEntrySchema>;
export type EntryRevisionInput = z.infer<typeof entryRevisionSchema>;
export type ArchiveEntriesInput = z.infer<typeof archiveEntriesSchema>;
export type CreateGroupInput = z.input<typeof createGroupSchema>;
export type RenameGroupInput = z.infer<typeof renameGroupSchema>;
export type ReorderGroupsInput = z.infer<typeof reorderGroupsSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type PurchaseHistoryPage = z.infer<typeof purchaseHistoryPageSchema>;
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
export type ReceiptBoundVia = z.infer<typeof receiptBoundViaSchema>;
export type ReceiptQuantityUnit = z.infer<typeof receiptQuantityUnitSchema>;
export type ReceiptReviewState = z.infer<typeof receiptReviewStateSchema>;
export type ReceiptListItem = z.infer<typeof receiptListItemSchema>;
export type ReceiptListPage = z.infer<typeof receiptListPageSchema>;
export type ReceiptLine = z.infer<typeof receiptLineSchema>;
export type ReceiptSuggestion = z.infer<typeof receiptSuggestionSchema>;
export type ReceiptDetailLine = z.infer<typeof receiptDetailLineSchema>;
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;
export type ReceiptParseQuality = z.infer<typeof receiptParseQualitySchema>;
export type ReceiptCapabilities = z.infer<typeof receiptCapabilitiesSchema>;
export type AliasSource = z.infer<typeof aliasSourceSchema>;
export type ItemAlias = z.infer<typeof itemAliasSchema>;
export type ItemAliases = z.infer<typeof itemAliasesSchema>;
export type AmbiguousPhrase = z.infer<typeof ambiguousPhraseSchema>;
export type AliasOverview = z.infer<typeof aliasOverviewSchema>;
export type UnknownLineGroup = z.infer<typeof unknownLineGroupSchema>;
export type UnknownLinesOverview = z.infer<typeof unknownLinesOverviewSchema>;
export type UnknownLinesBindInput = z.infer<typeof unknownLinesBindSchema>;
export type UnknownLinesBindResult = z.infer<
  typeof unknownLinesBindResultSchema
>;
export type MatchingStats = z.infer<typeof matchingStatsSchema>;
export type PriceFamily = z.infer<typeof priceFamilySchema>;
export type PriceBaseUnit = z.infer<typeof priceBaseUnitSchema>;
export type PriceTrend = z.infer<typeof priceTrendSchema>;
export type ItemPricePoint = z.infer<typeof itemPricePointSchema>;
export type ItemPriceFamily = z.infer<typeof itemPriceFamilySchema>;
export type ItemStorePrices = z.infer<typeof itemStorePricesSchema>;
export type ItemPrices = z.infer<typeof itemPricesSchema>;
export type ItemReferenceCounts = z.infer<typeof itemReferenceCountsSchema>;
export type ItemSummary = z.infer<typeof itemSummarySchema>;
export type ItemOverview = z.infer<typeof itemOverviewSchema>;
export type RenameItemInput = z.infer<typeof renameItemSchema>;
export type RenameItemResult = z.infer<typeof renameItemResultSchema>;
export type MergeItemsInput = z.infer<typeof mergeItemsSchema>;
export type MergeItemsResult = z.infer<typeof mergeItemsResultSchema>;
export type ReceiptLineEdit = z.infer<typeof receiptLineEditSchema>;
export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;
export type ReparseReceiptInput = z.infer<typeof reparseReceiptSchema>;
export type CommitReceiptInput = z.infer<typeof commitReceiptSchema>;
export type ReceiptRepairState = z.infer<typeof receiptRepairStateSchema>;
export type ReceiptRepairLineEdit = z.infer<typeof receiptRepairLineSchema>;
export type RepairReceiptInput = z.infer<typeof repairReceiptSchema>;
/** One line's repair without the id: what a row's controls hand to its parent. */
export type RepairLinePatch = Omit<ReceiptRepairLineEdit, 'id'>;
/** One line's edits without the id: what a row's form hands to its parent. */
export type ReceiptLinePatch = Omit<ReceiptLineEdit, 'id'>;
