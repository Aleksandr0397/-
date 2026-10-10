CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`connection_type` text DEFAULT 'price' NOT NULL,
	`lead_days` integer DEFAULT 0 NOT NULL,
	`contact_name` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`api_url` text DEFAULT '' NOT NULL,
	`api_docs_url` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "supplier_connection_type" CHECK(connection_type IN ('price','api','both')),
	CONSTRAINT "supplier_enabled" CHECK(enabled IN (0,1)),
	CONSTRAINT "supplier_lead_days" CHECK(lead_days >= 0 AND lead_days <= 365),
	CONSTRAINT "supplier_revision" CHECK(revision > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_name_key_unique` ON `suppliers` (`name_key`);--> statement-breakpoint
ALTER TABLE `imports` ADD `supplier_id` text REFERENCES suppliers(id);