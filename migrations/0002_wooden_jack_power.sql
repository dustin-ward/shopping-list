CREATE TABLE `item_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`catalog_item_id` text NOT NULL,
	`alias_text` text NOT NULL,
	`normalized_alias` text NOT NULL,
	`source` text NOT NULL,
	`created_by_receipt_line_id` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_receipt_line_id`) REFERENCES `receipt_lines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "item_aliases_source_check" CHECK("item_aliases"."source" IN ('manual', 'review', 'auto'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_aliases_live_unique` ON `item_aliases` (`list_id`,`catalog_item_id`,`normalized_alias`) WHERE "item_aliases"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `item_aliases_lookup` ON `item_aliases` (`list_id`,`normalized_alias`);--> statement-breakpoint
CREATE TABLE `receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`line_index` integer NOT NULL,
	`raw_text` text NOT NULL,
	`parsed_name` text,
	`quantity_real` real,
	`quantity_text` text,
	`quantity_unit` text,
	`unit_price_minor` integer,
	`total_price_minor` integer,
	`is_item_chunk` integer NOT NULL,
	`confidence` real,
	`catalog_item_id` text,
	`review_state` text DEFAULT 'unreviewed' NOT NULL,
	`bound_via` text,
	`bound_rank` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_lines_nonnegative_line_index" CHECK("receipt_lines"."line_index" >= 0),
	CONSTRAINT "receipt_lines_quantity_unit_check" CHECK("receipt_lines"."quantity_unit" IS NULL OR "receipt_lines"."quantity_unit" IN ('lb', 'kg', 'oz', 'g', 'l', 'ml', 'ea')),
	CONSTRAINT "receipt_lines_review_state_check" CHECK("receipt_lines"."review_state" IN ('unreviewed', 'bound', 'new', 'unknown', 'skipped')),
	CONSTRAINT "receipt_lines_bound_via_check" CHECK("receipt_lines"."bound_via" IS NULL OR "receipt_lines"."bound_via" IN ('auto', 'suggested', 'manual', 'created')),
	CONSTRAINT "receipt_lines_positive_bound_rank" CHECK("receipt_lines"."bound_rank" IS NULL OR "receipt_lines"."bound_rank" >= 1)
);
--> statement-breakpoint
CREATE INDEX `receipt_lines_receipt` ON `receipt_lines` (`receipt_id`,`line_index`);--> statement-breakpoint
CREATE INDEX `receipt_lines_catalog` ON `receipt_lines` (`catalog_item_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`image_path` text,
	`image_bytes` integer,
	`sha256` text NOT NULL,
	`ocr_json` text,
	`ocr_warnings` text,
	`currency` text,
	`subtotal_minor` integer,
	`tax_minor` integer,
	`total_minor` integer,
	`captured_at` text,
	`store_group_id` text,
	`parse_version` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`processed_at` text,
	`committed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipts_status_check" CHECK("receipts"."status" IN ('pending', 'processing', 'review', 'committed', 'discarded', 'failed')),
	CONSTRAINT "receipts_nonnegative_parse_version" CHECK("receipts"."parse_version" >= 0),
	CONSTRAINT "receipts_nonnegative_attempts" CHECK("receipts"."attempts" >= 0),
	CONSTRAINT "receipts_committed_requires_store" CHECK("receipts"."status" <> 'committed' OR "receipts"."store_group_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `receipts_status_work_queue` ON `receipts` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `receipts_list_status` ON `receipts` (`list_id`,`status`,`created_at`);