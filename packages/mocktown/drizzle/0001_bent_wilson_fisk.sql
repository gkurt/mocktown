CREATE TABLE `drift_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`services` text DEFAULT '[]' NOT NULL,
	`flows` text DEFAULT '[]' NOT NULL,
	`checked` integer DEFAULT 0 NOT NULL,
	`drifted` integer DEFAULT 0 NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`reasons` text DEFAULT '[]' NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `socket_frames` (
	`id` text PRIMARY KEY NOT NULL,
	`recording_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`direction` text NOT NULL,
	`encoding` text DEFAULT 'text' NOT NULL,
	`body` text NOT NULL,
	`at_ms` integer NOT NULL,
	FOREIGN KEY (`recording_id`) REFERENCES `recordings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `socket_frames_recording_idx` ON `socket_frames` (`recording_id`,`ordinal`);--> statement-breakpoint
ALTER TABLE `recordings` ADD `kind` text DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `request_encoding` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `response_encoding` text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE `recordings` ADD `socket_close` text;