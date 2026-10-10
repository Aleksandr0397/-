CREATE TABLE `supplier_connections` (
	`supplier_id` text PRIMARY KEY NOT NULL,
	`keys_cipher` text NOT NULL,
	`delivery_id` text DEFAULT '' NOT NULL,
	`address_id` integer,
	`options_json` text NOT NULL,
	`verified_at` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`last_request_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `suppliers` ADD `api_provider` text DEFAULT '' NOT NULL;