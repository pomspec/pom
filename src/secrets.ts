// What a journey types from a secret never shows: a password, a token, a key. A secret
// is an environment variable named like one (`POM_OWNER_PASSWORD`, `API_TOKEN`,
// `CLIENT_SECRET`) or named in pom.config.ts's `secrets`, and its value, wherever it
// would be written (a video's lines and checks, its captions and transcript, a
// `.feature`, the run's log), is written as dots instead. Pure: the environment is
// handed in, so the videos runner (`pom videos`), its reel in the browser's test worker
// and the prototype's eyes mask alike.

/** What a secret is written as: the same eight dots whatever its length, which they never tell. */
export const DOTS = "••••••••";

/** A name that holds a secret by its own word: *_PASSWORD, *_TOKEN, *_SECRET, or the word alone. */
const SECRET_NAME = /(?:^|_)(?:PASSWORD|TOKEN|SECRET)$/i;

/**
 * The fewest characters a secret's value has for it to be looked for inside other text: a
 * shorter one would turn every "1234" or "password" into dots. Quoted whole (a value a
 * line fills in) or typed whole, any secret is dots, whatever its length.
 */
const SHORTEST = 12;

/** A name pom's own secrets go by: a role's credentials (`POM_OWNER_PASSWORD`). */
const POM_NAME = /^POM_/i;

/** Whether a variable's name says it holds a secret, or the config names it as one. */
export const secretName = (name: string, listed: ReadonlyArray<string> = []) =>
  SECRET_NAME.test(name) || listed.includes(name);

/** The secrets' names the config lists, as `pom videos` hands them to its test workers. */
export const listedIn = (env: Readonly<Record<string, string | undefined>>) =>
  (env.POM_SECRETS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

/**
 * A secret's value, and whether its name has it looked for inside other text too: one the
 * config lists, or pom's own (`POM_*`). Any other (a CI job's `POSTGRES_PASSWORD`, whose
 * value may be "postgres") is dots only quoted or typed whole, never inside a word.
 */
export type Secret = Readonly<{ sought: boolean; value: string }>;

/** Every secret's value in an environment, the longest first (one inside another is dots whole). */
export function secretsIn(
  env: Readonly<Record<string, string | undefined>>,
  listed: ReadonlyArray<string> = listedIn(env),
): Array<Secret> {
  const values = new Map<string, boolean>();
  for (const [name, value] of Object.entries(env))
    if (value && secretName(name, listed))
      values.set(value, values.get(value) || POM_NAME.test(name) || listed.includes(name));
  return [...values]
    .map(([value, sought]) => ({ sought, value }))
    .sort((a, b) => b.value.length - a.value.length);
}

/** Whether a secret is looked for inside other text: sought by its name, and long enough. */
export const inside = (secret: Secret) => secret.sought && secret.value.length >= SHORTEST;

/** Masks: a text with every secret in it written as dots, and whether a typed value is one. */
export type Masker = Readonly<{
  /** The text with each secret's value in it as dots. */
  mask: (text: string) => string;
  /** Whether a value typed whole is a secret's. */
  isSecret: (value: string) => boolean;
}>;

/** A masker for these secrets. */
export function masker(secrets: ReadonlyArray<Secret>): Masker {
  const all = new Set(secrets.map((secret) => secret.value));
  const within = secrets.filter(inside).map((secret) => secret.value);
  return {
    isSecret: (value) => all.has(value),
    mask: (text) =>
      within.reduce(
        (said, value) => (said.includes(value) ? said.replaceAll(value, DOTS) : said),
        text.replace(
          /(["“])([^"”]*)(["”])/g,
          (whole, open: string, value: string, close: string) =>
            all.has(value) ? `${open}${DOTS}${close}` : whole,
        ),
      ),
  };
}

/** Every string in a value (a video's JSON) masked, keys left as they are. */
export function maskAll<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === "string") return mask(value) as T;
  if (Array.isArray(value)) return value.map((item) => maskAll(item, mask)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskAll(item, mask)]),
    ) as T;
  return value;
}
