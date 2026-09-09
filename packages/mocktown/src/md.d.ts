/**
 * The skill pack (`skills/` at the repo root) is authored as markdown and imported as text,
 * so tsc needs to know what a `.md` module is. Bun's own loader supplies the value; this
 * only supplies the type.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
