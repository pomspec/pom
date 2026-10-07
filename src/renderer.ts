import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import net from "node:net";

// Where pom's pictures are drawn. By default the machine's own Playwright Chromium:
// fast, its real fonts, and base and head drawn alike. `--docker` draws them in
// Playwright's own image instead, as CI does, for pictures meant to match CI's:
// `run-server` in the container, the browser reaching the machine's own app through
// the connection (`exposeNetwork: "<loopback>"`). Never required.

export type Docker = Readonly<{ platform: string; stop: () => void; wsEndpoint: string }>;

const free = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });

/** The image's platform for this machine: native, so Apple Silicon never emulates. */
export const nativePlatform = () => (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");

/**
 * Playwright's image for `version` with `run-server` in it, its stdin held open (it
 * exits when stdin closes). npm's cache is a volume handed to the image's user once,
 * so `npx` fetches Playwright only the first time.
 */
export async function startDocker(version: string, platform = nativePlatform()): Promise<Docker> {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
    throw new Error("--docker draws in Playwright's image, and Docker isn't running here.");
  }
  const image = `mcr.microsoft.com/playwright:v${version}-noble`;
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      platform,
      "--user",
      "root",
      "-v",
      "pom-npm:/home/pwuser/.npm",
      image,
      "chown",
      "-R",
      "pwuser:pwuser",
      "/home/pwuser/.npm",
    ],
    { stdio: "ignore" },
  );
  const port = await free();
  const name = `pom-renderer-${process.pid}`;
  const child: ChildProcess = spawn(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--init",
      "--ipc=host",
      "--platform",
      platform,
      "--name",
      name,
      "-p",
      `127.0.0.1:${port}:3000`,
      "-v",
      "pom-npm:/home/pwuser/.npm",
      "--user",
      "pwuser",
      "--workdir",
      "/home/pwuser",
      image,
      "/bin/sh",
      "-c",
      `npx -y playwright@${version} run-server --port 3000 --host 0.0.0.0`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const stop = () => {
    child.stdin?.end();
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  };
  process.once("exit", stop);
  await new Promise<void>((resolve, reject) => {
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      if (seen.includes("Listening on")) resolve();
    });
    child.once("exit", (code) =>
      reject(new Error(`Playwright's image exited (${code}) before it listened`)),
    );
  });
  return { platform, stop, wsEndpoint: `ws://127.0.0.1:${port}/` };
}
