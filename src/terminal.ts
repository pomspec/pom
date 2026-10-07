import { readFileSync } from "node:fs";

// Pictures in the terminal where it can show them (after athena-crisis's tests):
// the Kitty graphics protocol in Kitty and Ghostty, iTerm2's inline images in
// iTerm2 and WezTerm; elsewhere nothing, and the path printed beside is enough.

const ESC = "\u001B";
const CHUNK = 4096;

const kitty = () =>
  process.env.TERM === "xterm-kitty" ||
  process.env.TERM === "xterm-ghostty" ||
  process.env.TERM_PROGRAM?.toLowerCase() === "ghostty" ||
  Boolean(process.env.GHOSTTY_RESOURCES_DIR);

const iterm = () =>
  process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm";

/** Whether this terminal shows pictures inline (never when output is not a terminal). */
export const showsPictures = () => Boolean(process.stdout.isTTY) && (kitty() || iterm());

/** A PNG as the terminal draws it, `columns` wide; "" where it cannot. */
export function picture(file: string, columns = 60): string {
  if (!showsPictures()) return "";
  const data = readFileSync(file).toString("base64");
  if (iterm())
    return `${ESC}]1337;File=inline=1;width=${columns};preserveAspectRatio=1:${data}\u0007\n`;
  let out = "";
  for (let at = 0; at < data.length; at += CHUNK) {
    const first = at === 0;
    const last = at + CHUNK >= data.length;
    out += `${ESC}_G${first ? `a=T,f=100,c=${columns},` : ""}m=${last ? 0 : 1};${data.slice(at, at + CHUNK)}${ESC}\\`;
  }
  return `${out}\n`;
}
