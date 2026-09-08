-- `near-miss` is retired. It was filed from four places covering three different things:
-- a route that did not match but scored close, a socket channel that did not match, and a
-- handler (HTTP or socket) that matched exactly and then threw. The last of those is not a
-- miss at all, so it becomes `handler-error`; the rest are plainly unmatched requests.
--
-- The reason text is what tells them apart, and it is the only record of it that exists.
UPDATE `issues`
SET `type` = 'handler-error'
WHERE `type` = 'near-miss' AND `diagnosis` LIKE '%handler threw:%';
--> statement-breakpoint
UPDATE `issues`
SET `type` = 'unmatched-request'
WHERE `type` = 'near-miss';
