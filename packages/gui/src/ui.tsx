/**
 * The shell's primitives. Hand-written on purpose for now: these are the four or five
 * shapes the whole GUI is made of, and the house `@gkurt` shadcn-on-Base-UI registry is
 * where they should come from once this app needs a real component — a dialog, a combobox,
 * a data table. Each `TODO(registry)` marks a place where that swap is a one-liner.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { boot } from './api.ts';

/**
 * `scroll` caps the body and scrolls it, for a card whose content has no natural length —
 * a feed, a queue, a route list. Without it a dashboard's height is decided by whichever
 * widget happened to have the most rows, and the rest of the grid is dragged along with it.
 * One cap for every card rather than a per-card number: matching heights is the point.
 *
 * The fade brings paint containment with it, which makes the card a containing block for
 * anything positioned `fixed` inside it — so a capped card is the wrong place for a dial,
 * whose popup would be clipped to the card instead of escaping it.
 */
export function Card({ title, action, scroll, children }: { title: string; action?: ReactNode; scroll?: boolean; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-raised">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h2 className="font-medium">{title}</h2>
        {action}
      </header>
      <div className={`p-3 ${scroll ? 'max-h-72 scrollable scrollable-transition scroll-fade' : ''}`}>{children}</div>
    </section>
  );
}

/** TODO(registry): replace with the registry's `data-table` once sorting or paging is wanted. */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="scrollable scrollable-transition scroll-fade-inline">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-muted">
            {head.map((column) => (
              <th key={column} className="border-b border-line px-2 py-1 text-left font-medium whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const Cell = ({ children, mono, className = '' }: { children?: ReactNode; mono?: boolean; className?: string }) => (
  <td className={`border-b border-line px-2 py-1 align-top ${mono ? 'font-mono' : ''} ${className}`}>{children}</td>
);

/**
 * A table row that opens something — a drawer, in every current use. Give the table a
 * leading `''` column for the caret this renders.
 *
 * The whole row takes a click, because a row that opens a detail view and only accepts the
 * click on one word of itself is a target the reader has to aim at. The caret is a real
 * `<button>` rather than a `role` on the `<tr>`: relabelling a row as a button takes the
 * row-and-cell semantics away from everything inside it, and the row was already the thing
 * a screen reader wanted to read. So the button carries the name and the keyboard, and the
 * row carries the pointer.
 *
 * The caret also has to exist for its own sake — the affordance is the only thing that says
 * a row does anything at all, and a table that silently opens a drawer on click is a table
 * nobody clicks.
 */
export function RowButton({
  label,
  onOpen,
  selected,
  children,
}: {
  label: string;
  onOpen: () => void;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <tr onClick={onOpen} className={`cursor-pointer hover:bg-line/40 focus-within:bg-line/40 ${selected ? 'bg-line/30' : ''}`}>
      <Cell className="w-0">
        <button type="button" onClick={onOpen} aria-label={`Open ${label}`} className="px-1 text-muted hover:text-ink">
          {selected ? '▾' : '▸'}
        </button>
      </Cell>
      {children}
    </tr>
  );
}

const TONES = {
  good: 'text-good border-good/40 bg-good/10',
  warn: 'text-warn border-warn/40 bg-warn/10',
  bad: 'text-bad border-bad/40 bg-bad/10',
  plain: 'text-muted border-line',
} as const;

export function Badge({ tone = 'plain', children }: { tone?: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] leading-none ${TONES[tone]}`}>{children}</span>;
}

/** TODO(registry): registry `button`, once there is a variant beyond this one. */
export function Button({ onClick, children, disabled }: { onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded border border-line px-2 py-1 hover:bg-line/40 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/**
 * A destructive action, armed by a first click and run by a second.
 *
 * The registry's dialog is the eventual home for this, but a modal is the wrong shape for
 * the thing being confirmed here: "delete these 14 recordings" is a row-level decision, and
 * a dialog that restates it in the middle of the screen adds a step without adding
 * information the row did not already show. Arming in place keeps the subject under the
 * cursor — the reader confirms the row they are pointing at, not a sentence about it.
 *
 * It disarms itself, because a button left armed behind a scroll is a trap for the next
 * click that lands near it.
 *
 * TODO(registry): registry `alert-dialog`, if a confirmation ever needs to explain itself
 * at more length than a button can hold.
 */
export function Danger({
  label,
  armed,
  onConfirm,
  disabled,
}: {
  label: ReactNode;
  armed: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [live, setLive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        clearTimeout(timer.current);
        if (live) {
          setLive(false);
          onConfirm();
          return;
        }
        setLive(true);
        timer.current = setTimeout(() => setLive(false), 4000);
      }}
      className={`rounded border px-2 py-1 leading-none disabled:opacity-40 ${
        live ? 'border-bad/60 bg-bad/15 text-bad' : 'border-line text-muted hover:bg-line/40'
      }`}
    >
      {live ? armed : label}
    </button>
  );
}

/**
 * A filesystem path, with the home directory shortened to `~`. The daemon puts the home in
 * the boot block because a browser has no way to know it.
 *
 * The full path stays in `title`, since the shortened form is for reading and the real one
 * is what gets pasted into a terminal. The trailing slash is the guard: `~` for
 * `/Users/ann` must not also claim `/Users/annex`.
 */
export function Path({ children, className = '' }: { children: string; className?: string }) {
  const short = boot.home === '/' ? children : children.replaceAll(`${boot.home}/`, '~/');
  return (
    <span className={`font-mono ${className}`} title={short === children ? undefined : children}>
      {short}
    </span>
  );
}

export const Muted = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <span className={`text-muted ${className}`}>{children}</span>
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="text-muted">{children}</p>;

/**
 * Every failure is shown with its message. The daemon's errors are written to be read —
 * a wall hit or a missing provider explains itself — so swallowing them into "something
 * went wrong" would throw away the most useful text in the product.
 */
export function Failure({ error }: { error: unknown }) {
  return (
    <p className="rounded border border-bad/40 bg-bad/10 px-2 py-1 text-bad">{error instanceof Error ? error.message : String(error)}</p>
  );
}

export function Pending({ what }: { what: string }) {
  return <p className="text-muted">loading {what}…</p>;
}

export const Ok = ({ ok, children }: { ok: boolean; children?: ReactNode }) => (
  <Badge tone={ok ? 'good' : 'bad'}>{children ?? (ok ? 'ok' : 'no')}</Badge>
);

/**
 * Copy to clipboard, with the confirmation in the button itself. Credentials and tokens are
 * meant to be pasted somewhere else — into a login form, into a request — so selecting them
 * by hand was the one interaction this GUI asked for and did not help with.
 *
 * `navigator.clipboard` needs a secure context; the daemon serves over plain HTTP on
 * loopback, which qualifies, but a failure is shown rather than swallowed.
 */
export function Copy({ value, label }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  return (
    <button
      type="button"
      title={`Copy ${label ?? 'to clipboard'}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState('done');
        } catch {
          setState('failed');
        }
        setTimeout(() => setState('idle'), 1200);
      }}
      className="rounded border border-line px-1 py-0.5 text-[11px] leading-none text-muted hover:bg-line/40"
    >
      {state === 'done' ? 'copied' : state === 'failed' ? 'blocked' : 'copy'}
    </button>
  );
}

/**
 * A drawer for one row's detail, built on the native `<dialog>`.
 *
 * It replaces the expanding row this shell used to have. An expansion put the detail *below*
 * the table, which meant the row that opened it was pushed off screen by the thing it
 * opened, every other row moved under the cursor, and a payload the size of an issue's
 * diagnosis reflowed the page each time one was clicked. A drawer leaves the list exactly
 * where it was and puts the detail beside it, so clicking down a list of issues compares
 * them instead of relayouting around them.
 *
 * `<dialog>` rather than a positioned `<div>`: modality, the top layer, focus containment,
 * inert background and Escape are all platform behaviour, and a hand-rolled panel gets some
 * subset of them wrong. Being in the top layer is also what keeps a drawer out of the
 * `scroll-fade` containment on the page behind it. Clicking the backdrop closes, because a
 * click that lands on a modal's backdrop has already targeted the dialog element itself.
 *
 * TODO(registry): the house registry's `sheet`, once it is vendored — same shape, same
 * `<dialog>` underneath.
 */
export function Drawer({
  open,
  title,
  action,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  action?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDialogElement>(null);

  // `showModal()` is a method, not an attribute, so the open state has to be pushed at the
  // element. Rendering `open` instead would give a non-modal dialog: no backdrop, no top
  // layer, no Escape.
  useEffect(() => {
    const dialog = frame.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={frame}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="drawer my-0 mr-0 ml-auto h-dvh max-h-dvh w-[min(38rem,100vw)] max-w-none border-line border-l bg-raised p-0 text-ink"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-3 border-line border-b px-3 py-2">
          <h2 className="min-w-0 truncate font-medium">{title}</h2>
          <span className="flex shrink-0 items-center gap-2">
            {action}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded border border-line px-2 py-1 leading-none text-muted hover:bg-line/40"
            >
              ✕
            </button>
          </span>
        </header>
        <div className="min-h-0 grow scrollable scrollable-transition scroll-fade p-3">{children}</div>
      </div>
    </dialog>
  );
}
