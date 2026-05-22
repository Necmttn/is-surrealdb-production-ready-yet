// Tiny dependency-free terminal UI: ASCII banner, colours, spinner, and a
// box-drawn results table. Built for `bun`.

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

export const paint = (s: string, ...codes: (keyof typeof C)[]) =>
  codes.map((c) => C[c]).join("") + s + C.reset;

/** ASCII-art banner printed at suite start. */
export function banner(image: string): void {
  const cy = (s: string) => paint(s, "cyan");
  console.log("");
  console.log(cy("       ___"));
  console.log(cy("      /   /|") + "      IS  SURREALDB");
  console.log(cy("     /___/ |") + "      " + paint("P R O D U C T I O N   R E A D Y   Y E T ?", "bold", "cyan"));
  console.log(cy("     |   | /") + "      " + paint("─".repeat(42), "dim"));
  console.log(cy("     |   |/") + "       vector-index reproducible test suite");
  console.log(cy("     |___|") + "        " + paint("image: " + image, "dim"));
  console.log("");
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A live single-line spinner for a running test; call .done(...) to resolve.
 *  Animates only on a TTY - in piped/CI output it just prints the result. */
export function spinner(label: string) {
  const tty = process.stdout.isTTY;
  let i = 0;
  const tick = () => {
    process.stdout.write("\r  " + paint(SPIN[i++ % SPIN.length], "yellow") + "  " + label + "   ");
  };
  const handle = tty ? setInterval(tick, 80) : null;
  if (tty) tick();
  return {
    done(ok: boolean, detail = "") {
      if (handle) clearInterval(handle);
      const mark = ok ? paint("✔ PASS", "green", "bold") : paint("✘ FAIL", "red", "bold");
      const pre = tty ? "\r" : "";
      process.stdout.write(pre + "  " + mark + "  " + label + (detail ? "  " + paint(detail, "dim") : "") + (tty ? "\x1b[K" : "") + "\n");
    },
  };
}

export interface Col { key: string; label: string; width: number }

/** Box-drawn results table. `verdict(row)` -> "pass" | "fail" | "warn" tints a row. */
export function table(cols: Col[], rows: Record<string, unknown>[], verdict?: (r: Record<string, unknown>) => string): void {
  const line = (l: string, m: string, r: string) =>
    l + cols.map((c) => "─".repeat(c.width + 2)).join(m) + r;
  const cell = (v: unknown, w: number) => {
    const s = String(v ?? "");
    return " " + (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w)) + " ";
  };
  console.log(paint(line("┌", "┬", "┐"), "dim"));
  console.log(
    paint("│", "dim") +
      cols.map((c) => paint(cell(c.label, c.width), "bold")).join(paint("│", "dim")) +
      paint("│", "dim"),
  );
  console.log(paint(line("├", "┼", "┤"), "dim"));
  for (const row of rows) {
    const v = verdict?.(row);
    const tint: (keyof typeof C)[] = v === "pass" ? ["green"] : v === "fail" ? ["red"] : v === "warn" ? ["yellow"] : ["reset"];
    console.log(
      paint("│", "dim") +
        cols.map((c) => paint(cell(row[c.key], c.width), ...tint)).join(paint("│", "dim")) +
        paint("│", "dim"),
    );
  }
  console.log(paint(line("└", "┴", "┘"), "dim"));
}

export const heading = (s: string) => console.log("\n" + paint("▍ " + s, "magenta", "bold"));

const ART_NO = [
  "███╗   ██╗ ██████╗ ",
  "████╗  ██║██╔═══██╗",
  "██╔██╗ ██║██║   ██║",
  "██║╚██╗██║██║   ██║",
  "██║ ╚████║╚██████╔╝",
  "╚═╝  ╚═══╝ ╚═════╝ ",
];
const ART_YES = [
  "██╗   ██╗███████╗███████╗",
  "╚██╗ ██╔╝██╔════╝██╔════╝",
  " ╚████╔╝ █████╗  ███████╗",
  "  ╚██╔╝  ██╔══╝  ╚════██║",
  "   ██║   ███████╗███████║",
  "   ╚═╝   ╚══════╝╚══════╝",
];

/** Big block-letter verdict: is it production ready? */
export function verdictArt(passed: boolean): void {
  const art = passed ? ART_YES : ART_NO;
  const color: keyof typeof C = passed ? "green" : "red";
  console.log("\n  " + paint("is surrealdb production ready yet?", "dim"));
  console.log("");
  for (const l of art) console.log("   " + paint(l, color, "bold"));
  console.log("");
}
