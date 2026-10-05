CREATE TABLE `app_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "app_state_singleton_id" CHECK("app_state"."id" = 1),
	CONSTRAINT "app_state_nonnegative_revision" CHECK("app_state"."revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `app_state_list_id_unique` ON `app_state` (`list_id`);--> statement-breakpoint
CREATE TABLE `catalog_item_groups` (
	`catalog_item_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`catalog_item_id`, `group_id`),
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `catalog_item_groups_group_index` ON `catalog_item_groups` (`group_id`);--> statement-breakpoint
CREATE TABLE `catalog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_items_list_normalized_name_unique` ON `catalog_items` (`list_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `entry_groups` (
	`entry_id` text NOT NULL,
	`group_id` text NOT NULL,
	PRIMARY KEY(`entry_id`, `group_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `list_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entry_groups_group_index` ON `entry_groups` (`group_id`);--> statement-breakpoint
CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "groups_kind_check" CHECK("groups"."kind" IN ('store', 'category')),
	CONSTRAINT "groups_nonnegative_position" CHECK("groups"."position" >= 0),
	CONSTRAINT "groups_positive_revision" CHECK("groups"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_live_name_unique` ON `groups` (`list_id`,`normalized_name`) WHERE "groups"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `groups_list_position_index` ON `groups` (`list_id`,`position`);--> statement-breakpoint
CREATE TABLE `list_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`catalog_item_id` text NOT NULL,
	`name` text NOT NULL,
	`quantity_text` text,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`completed_at` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "list_entries_status_check" CHECK("list_entries"."status" IN ('active', 'purchased', 'cancelled')),
	CONSTRAINT "list_entries_positive_revision" CHECK("list_entries"."revision" > 0),
	CONSTRAINT "list_entries_consistent_state" CHECK((
				("list_entries"."status" = 'active' AND "list_entries"."completed_at" IS NULL AND "list_entries"."archived_at" IS NULL)
				OR ("list_entries"."status" = 'purchased' AND "list_entries"."completed_at" IS NOT NULL)
				OR ("list_entries"."status" = 'cancelled' AND "list_entries"."completed_at" IS NULL AND "list_entries"."archived_at" IS NOT NULL)
			))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `list_entries_one_active_item_unique` ON `list_entries` (`list_id`,`catalog_item_id`) WHERE "list_entries"."status" = 'active' AND "list_entries"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `list_entries_current_index` ON `list_entries` (`list_id`,`status`,`archived_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`catalog_item_id` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`quantity_snapshot` text,
	`note_snapshot` text,
	`purchased_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`store_group_id` text,
	`store_name_snapshot` text,
	`voided_at` text,
	FOREIGN KEY (`entry_id`) REFERENCES `list_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`catalog_item_id`) REFERENCES `catalog_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchases_store_snapshot_consistency" CHECK(("purchases"."store_group_id" IS NULL AND "purchases"."store_name_snapshot" IS NULL)
				OR ("purchases"."store_group_id" IS NOT NULL AND "purchases"."store_name_snapshot" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_one_valid_per_entry_unique` ON `purchases` (`entry_id`) WHERE "purchases"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX `purchases_catalog_item_time_index` ON `purchases` (`catalog_item_id`,`purchased_at`);--> statement-breakpoint
CREATE INDEX `purchases_time_index` ON `purchases` (`purchased_at`,`id`);