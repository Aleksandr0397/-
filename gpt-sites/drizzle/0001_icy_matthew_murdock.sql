CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`kind` text NOT NULL,
	`reference_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_reference_id_unique` ON `ledger` (`reference_id`);--> statement-breakpoint
CREATE TABLE `topups` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reference` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`approved_at` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "topup_positive" CHECK(amount_cents > 0)
);
--> statement-breakpoint
CREATE TABLE `vin_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`vin` text NOT NULL,
	`vehicle` text NOT NULL,
	`details` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `customers` ADD `markup_bps` integer DEFAULT 0 NOT NULL CONSTRAINT "markup_range" CHECK(markup_bps >= 0 AND markup_bps <= 100000);
--> statement-breakpoint
ALTER TABLE `imports` ADD `source_name` text DEFAULT 'Мой склад' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `source_type` text DEFAULT 'warehouse' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `lead_days` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `source_name` text DEFAULT 'Мой склад' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `source_type` text DEFAULT 'warehouse' NOT NULL;--> statement-breakpoint
ALTER TABLE `order_items` ADD `lead_days` integer;