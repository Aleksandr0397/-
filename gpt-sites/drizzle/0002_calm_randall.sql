CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`delta` integer,
	`kind` text NOT NULL,
	`reference_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `orders` ADD `channel` text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `fiscal_status` text DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `warehouse` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `bin` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `min_stock` integer DEFAULT 0 NOT NULL;