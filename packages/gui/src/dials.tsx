/**
 * Dials — DialKit's controls, wearing this app's palette.
 *
 * DialKit ships as a floating panel for tuning a running interface, and none of that is used
 * here: `DialRoot`, the preset menu and the timeline dock all stay behind, and only the
 * individual controls are mounted, which the package exports for exactly this ("custom
 * layouts"). What they bring is the part that is tedious and easy to get wrong by hand — a
 * slider you can drag, scroll, arrow-key and type a number into; a select with a positioned,
 * keyboard-driven popup; an autosizing text field — behind one labelled row shape, so a
 * setting, a scenario knob and a service's provider all read as the same kind of control.
 * The colours are rebound in styles.css.
 *
 * Every control here is *committing*, not *live*: each change is an API call that writes to
 * `mocktown.json` or to project state, so something has to decide when a gesture is
 * finished. DialKit leaves that to the caller, which is why the two controls whose gesture
 * has no end of its own — a text field and a slider — are wrapped below, and the two that
 * fire once per decision are re-exported as they are.
 */
import { SelectControl, Slider, TextControl, Toggle } from 'dialkit';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useScheme } from './theme.ts';
// Imported here rather than from the Tailwind entry so it travels with the only module that
// mounts a DialKit control, and so the remote-font `@import` it opens with goes through the
// build's own strip (vite.config.ts) instead of Tailwind's import resolver.
import 'dialkit/styles.css';

/**
 * The container every control needs: DialKit scopes its tokens to `.dialkit-root`, so a
 * control mounted outside one has no colours at all. It is also the portal target for the
 * select popup (DialKit walks up to the nearest root), which is what keeps a dropdown inside
 * a drawer's top layer instead of underneath it.
 *
 * `data-theme` is passed straight through, because DialKit's three states are the same three
 * this app has and it can watch the OS itself.
 *
 * `row` rather than a class, because `flex-col` and `flex-row` are the same property and
 * which one wins is decided by Tailwind's output order, not by the order they are passed in.
 */
export function Dials({ children, row, className = '' }: { children: ReactNode; row?: boolean; className?: string }) {
  const scheme = useScheme();

  return (
    <div className={`dials dialkit-root flex gap-1.5 ${row ? 'items-center' : 'flex-col'} ${className}`} data-theme={scheme}>
      {children}
    </div>
  );
}

// A pick and a flip are each one decision, so there is nothing for a wrapper to debounce or
// hold: these commit on the change they report.
export { SelectControl as Choice, Toggle as Switch };

/**
 * A text dial that commits on Enter and reverts on Escape, rather than on every keystroke.
 *
 * The setting behind one of these is a committed line of `mocktown.json` — `capture.ignore`
 * is a list of hostnames — so a per-keystroke write would put a dozen half-typed values
 * through the file, and losing focus should not be what decides a value is finished.
 *
 * The interception is on the wrapper because DialKit's field is an autosizing `<textarea>`:
 * it takes no key handler of its own, and Enter would otherwise insert a newline. Capture
 * phase runs before that default, and Shift+Enter is left alone for the multi-line case.
 */
export function TextDial({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;

  // The draft outlives the commit, and is dropped once the value comes back matching it.
  // Clearing it at commit time instead put the *old* value back on screen for the length of
  // the round trip, which reads as the field rejecting what was just typed.
  useEffect(() => {
    if (draft !== null && draft === value) setDraft(null);
  }, [draft, value]);

  return (
    <div
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          setDraft(null);
          return;
        }
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        onCommit(text);
      }}
    >
      <TextControl label={label} value={text} placeholder={placeholder} onChange={(next) => setDraft(next)} />
    </div>
  );
}

/**
 * A numeric dial that tracks the drag and writes once it stops.
 *
 * A slider fires on every frame of a drag, and each one of these is a `knobs.set` against
 * the running mock. Committing per frame would send a hundred writes for one gesture — all
 * but the last of them wrong — so the value shown is local and the write trails it by a
 * beat. Debouncing rather than waiting for pointer-up because the same control is also
 * driven by arrow keys and by scrolling, which have no release to wait for.
 */
export function Range({
  label,
  value,
  min,
  max,
  step,
  unit,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Held until the server reports the same number back, the same way the text dial holds its
  // draft. A slider that snapped back to the old value while the write was in flight looked
  // exactly like a slider that had refused to move.
  useEffect(() => {
    if (local !== null && local === value) setLocal(null);
  }, [local, value]);

  return (
    <Slider
      label={label}
      value={local ?? value}
      min={min}
      max={max}
      step={step}
      unit={unit}
      onChange={(next) => {
        setLocal(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(next), 250);
      }}
    />
  );
}
