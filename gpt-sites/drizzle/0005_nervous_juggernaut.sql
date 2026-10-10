CREATE TABLE `product_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`file_key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "photo_position" CHECK(position >= 0 AND position < 5),
	CONSTRAINT "photo_size" CHECK(size_bytes > 0 AND size_bytes <= 3000000),
	CONSTRAINT "photo_dimensions" CHECK(width > 0 AND width <= 6000 AND height > 0 AND height <= 6000 AND width*height <= 24000000),
	CONSTRAINT "photo_content_type" CHECK(content_type IN ('image/jpeg','image/png','image/webp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_photo_position` ON `product_photos` (`product_id`,`position`);