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

export const receiptBoundViaSchema = z.enum([
  'auto',
  'suggested',
  'manual',
  'created',
]);

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
  lines: z.array(receiptDetailLineSchema),
});

export const receiptCapabilitiesSchema = z.object({
  enabled: z.boolean(),
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
export type ReceiptQuantityUnit = z.infer<typeof receiptQuantityUnitSchema>;
export type ReceiptReviewState = z.infer<typeof receiptReviewStateSchema>;
export type ReceiptListItem = z.infer<typeof receiptListItemSchema>;
export type ReceiptListPage = z.infer<typeof receiptListPageSchema>;
export type ReceiptLine = z.infer<typeof receiptLineSchema>;
export type ReceiptSuggestion = z.infer<typeof receiptSuggestionSchema>;
export type ReceiptDetailLine = z.infer<typeof receiptDetailLineSchema>;
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;
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
export type ReceiptLineEdit = z.infer<typeof receiptLineEditSchema>;
export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;
export type CommitReceiptInput = z.infer<typeof commitReceiptSchema>;
export type ReceiptRepairState = z.infer<typeof receiptRepairStateSchema>;
export type ReceiptRepairLineEdit = z.infer<typeof receiptRepairLineSchema>;
export type RepairReceiptInput = z.infer<typeof repairReceiptSchema>;
/** One line's repair without the id: what a row's controls hand to its parent. */
export type RepairLinePatch = Omit<ReceiptRepairLineEdit, 'id'>;
/** One line's edits without the id: what a row's form hands to its parent. */
export type ReceiptLinePatch = Omit<ReceiptLineEdit, 'id'>;
