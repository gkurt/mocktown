CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`content_type` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ekb` (
	`id` text PRIMARY KEY NOT NULL,
	`service` text NOT NULL,
	`rung` integer NOT NULL,
	`env_var` text,
	`language` text,
	`snippet` text,
	`note` text,
	`source` text DEFAULT 'builtin' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ekb_service_idx` ON `ekb` (`service`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`service` text NOT NULL,
	`method` text,
	`path` text,
	`path_template` text,
	`batch_id` text,
	`session_id` text,
	`request` text,
	`diagnosis` text,
	`suggested_resolution` text,
	`links` text DEFAULT '[]' NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`resolution_note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `issues` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `issues_dedupe_idx` ON `issues` (`type`,`service`,`method`,`path_template`);--> statement-breakpoint
CREATE TABLE `journal` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`service` text,
	`payload` text NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_session_idx` ON `journal` (`session_id`);--> statement-breakpoint
CREATE TABLE `knob_values` (
	`service` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`service`, `key`)
);
--> statement-breakpoint
CREATE TABLE `mock_state` (
	`service` text NOT NULL,
	`profile` text DEFAULT 'default' NOT NULL,
	`collection` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`seeded` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`service`, `profile`, `collection`, `key`)
);
--> statement-breakpoint
CREATE INDEX `mock_state_scope_idx` ON `mock_state` (`service`,`profile`,`collection`);--> statement-breakpoint
CREATE TABLE `profile_sessions` (
	`token` text PRIMARY KEY NOT NULL,
	`profile` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`profile`) REFERENCES `profiles`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`credentials` text DEFAULT '{}' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`knob_overrides` text DEFAULT '{}' NOT NULL,
	`sign_in` text DEFAULT 'credentials' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`service` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`path_template` text NOT NULL,
	`query` text DEFAULT '{}' NOT NULL,
	`status_code` integer NOT NULL,
	`request_headers` text NOT NULL,
	`response_headers` text NOT NULL,
	`request_body` text,
	`response_body` text,
	`request_blob` text,
	`response_blob` text,
	`duration_ms` integer,
	`scrub_summary` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'front-door' NOT NULL,
	`recorded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recordings_service_idx` ON `recordings` (`service`);--> statement-breakpoint
CREATE INDEX `recordings_route_idx` ON `recordings` (`service`,`method`,`path_template`);--> statement-breakpoint
CREATE INDEX `recordings_session_idx` ON `recordings` (`session_id`);--> statement-breakpoint
CREATE TABLE `seal_stamps` (
	`id` text PRIMARY KEY NOT NULL,
	`commit` text,
	`config_hash` text NOT NULL,
	`sealed` integer NOT NULL,
	`flows` text DEFAULT '[]' NOT NULL,
	`wall_hits` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`seed` text,
	`discovered` integer DEFAULT false NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`seed` text NOT NULL,
	`label` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text
);
