CREATE TABLE `purchase_order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`warehouse_product_id` text NOT NULL,
	`supplier_product_id` text NOT NULL,
	`code` text NOT NULL,
	`brand` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`received_qty` integer DEFAULT 0 NOT NULL,
	`unit_cost_cents` integer NOT NULL,
	`lead_days` integer,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warehouse_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_quantity_positive" CHECK(quantity > 0),
	CONSTRAINT "purchase_received_range" CHECK(received_qty >= 0 AND received_qty <= quantity),
	CONSTRAINT "purchase_cost_positive" CHECK(unit_cost_cents > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_purchase_line` ON `purchase_order_items` (`purchase_id`,`warehouse_product_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`supplier_name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total_cents` integer NOT NULL,
	`created_at` text NOT NULL,
	`ordered_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `purchase_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_total_positive" CHECK(total_cents > 0)
);
--> statement-breakpoint
CREATE TABLE `purchase_receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`purchase_item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `purchase_receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`purchase_item_id`) REFERENCES `purchase_order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_quantity_positive" CHECK(quantity > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_receipt_line` ON `purchase_receipt_items` (`receipt_id`,`purchase_item_id`);--> statement-breakpoint
CREATE TABLE `purchase_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_receipts_idempotency_key_unique` ON `purchase_receipts` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `purchase_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_runs_idempotency_key_unique` ON `purchase_runs` (`idempotency_key`);