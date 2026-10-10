CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'customer' NOT NULL,
	`discount_bps` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "discount_range" CHECK(discount_bps >= 0 AND discount_bps <= 8000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_auth_user_id_unique` ON `customers` (`auth_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `customers_email_unique` ON `customers` (`email`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`file_key` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`code` text NOT NULL,
	`brand` text NOT NULL,
	`name` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_cents` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "quantity_positive" CHECK(quantity > 0)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`total_cents` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "total_positive" CHECK(total_cents > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_checkout` ON `orders` (`customer_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`code` text NOT NULL,
	`brand` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`search_text` text NOT NULL,
	`stock` integer,
	`price_cents` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_nonnegative" CHECK(stock IS NULL OR stock >= 0),
	CONSTRAINT "price_positive" CHECK(price_cents > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `offer_code_brand` ON `products` (`import_id`,`code`,`brand`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
