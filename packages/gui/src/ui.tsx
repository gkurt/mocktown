/**
 * The shell's primitives. Hand-written on purpose for now: these are the four or five
 * shapes the whole GUI is made of, and the house `@gkurt` shadcn-on-Base-UI registry is
 * where they should come from once this app needs a real component — a dialog, a combobox,
 * a data table. Each `TODO(registry)` marks a place where that swap is a one-liner.
 */
import { type ReactNode, useState } from 'react';

export function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-raised">
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <h2 className="font-medium">{title}</h2>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** TODO(registry): replace with the registry's `data-table` once sorting or paging is wanted. */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
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
