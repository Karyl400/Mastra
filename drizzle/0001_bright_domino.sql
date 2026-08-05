CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`actor_id` text NOT NULL,
	`resource_id` text,
	`resource_type` text,
	`details` text,
	`created_at` text NOT NULL
);
