/**
 * mocktown's own icon, and the paths a browser asks every origin for.
 *
 * A browser requests an icon from every host it visits, so every port mocktown opens was
 * answering the same question wrong: a generated mock filed an `unmatched-request` for a
 * route it was never going to have, and the GUI 404'd. Serving one small mark instead
 * costs nothing, keeps browser plumbing out of the issue queue, and makes a mocked tab
 * visibly a mocked tab in the tab strip.
 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR42mOQ1zL/TwlmABH84lpk4VEDcBhgsfcHXjwSDBhNB2QaQAkGAPxOjfBnD3TbAAAAAElFTkSuQmCC';

export const MARK = Uint8Array.from(atob(PNG), (c) => c.charCodeAt(0));

/** The chrome a browser fetches unprompted. Not routes — a mock that lacks them is not incomplete. */
export const BROWSER_CHROME = new Set(['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']);

export function markResponse(): Response {
  return new Response(MARK, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } });
}
