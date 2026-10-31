import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { appByName, loadApps, paths } from "./config.ts";
import { findRoot, hostFor, listeners, run } from "./discover.ts";
import { init } from "./init.ts";
import { targetFor, tilde } from "./setup.ts";
import { generatedCaddyfile, loadManual, portOf, saveManual, sync, type SyncResult } from "./sync.ts";

const usage = `devhost: give locally running apps hostnames through Caddy

Usage:
  devhost up                              register everything running, print this worktree's URLs
  devhost ls                              register everything running, list all routes
  devhost watch [--interval <seconds>]    keep registering as apps start and stop
  devhost init [dir]                      set up the app running in dir (default: here), interactively
  devhost add <app>/<instance> <port> [--host <name>] [--host-header upstream]
                                          route a port by hand (host defaults to <instance>)
  devhost rm <app>/<instance> [--host <name>]
                                          remove a hand-made route
  devhost paths                           show config, state and Caddy file locations

Apps are configured in ${paths.apps}/<app>.json`;

function fail(message: string): never {
  process.stderr.write(`devhost: ${message}\n`);
  process.exit(1);
}

function report(result: SyncResult) {
  if (result.error) process.stderr.write(`devhost: caddy reload failed, kept the previous routes:\n${result.error}\n`);
}

function time(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function printRoutes(result: SyncResult, filter?: (dir?: string) => boolean) {
  const alive = new Set(listeners().map((listener) => listener.port));
  const instances = result.instances.filter((instance) => !filter || filter(instance.dir));
  if (instances.length === 0) {
    process.stdout.write("nothing registered\n");
    return;
  }
  for (const instance of instances) {
    const branch = instance.branch ? ` (${instance.branch})` : "";
    process.stdout.write(`${instance.app}/${instance.instance}${branch}${instance.source === "manual" ? " [manual]" : ""}\n`);
    for (const route of instance.routes) {
      const state = alive.has(portOf(route.upstream)) ? "" : "  [down]";
      process.stdout.write(`  https://${route.host}  →  ${route.upstream}${state}\n`);
    }
  }
}

function parseTarget(target: string | undefined): { app: string; instance: string } {
  const match = /^([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(target ?? "");
  if (!match) fail(`expected <app>/<instance>, got "${target ?? ""}"`);
  return { app: match[1]!, instance: match[2]! };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    "host-header": { type: "string" },
    interval: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command = "ls", ...rest] = positionals;
let apps = loadApps();

if (values.help || command === "help") {
  process.stdout.write(`${usage}\n`);
} else if (command === "up") {
  const result = sync(apps, listeners());
  report(result);
  const cwd = process.cwd();
  const root = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).trim() || cwd;
  const known = apps.some((app) => findRoot(app, root));
  if (!known) process.stdout.write(`no app in ${paths.apps} matches ${root}; run \`devhost init\` to set it up. Showing everything:\n`);
  printRoutes(result, known ? (dir) => dir === root : undefined);
} else if (command === "ls") {
  const result = sync(apps, listeners());
  report(result);
  printRoutes(result);
} else if (command === "watch") {
  const seconds = Number(values.interval ?? 3);
  if (!(seconds > 0)) fail("--interval must be a positive number");
  process.stdout.write(`${time()} watching every ${seconds}s\n`);
  let last = "";
  const tick = () => {
    const result = sync(apps, listeners());
    report(result);
    const summary = result.instances
      .flatMap((instance) => instance.routes.map((route) => `${route.host} → ${route.upstream}`))
      .join("\n  ");
    if (summary !== last) process.stdout.write(`${time()} routes:\n  ${summary || "(none)"}\n`);
    last = summary;
  };
  tick();
  setInterval(tick, seconds * 1000);
} else if (command === "init") {
  const dir = resolve(rest[0] ?? process.cwd());
  const all = listeners();
  const target = targetFor(dir, all);
  if (!target) fail(`${tilde(dir)} isn't inside a git repository`);
  const owner = apps.find((app) => findRoot(app, target.root));
  if (owner) fail(`${tilde(target.root)} already belongs to ${owner.name}; edit ${tilde(owner.file ?? paths.apps)} to change it`);
  if (target.listeners.length === 0) fail(`nothing is listening in ${tilde(target.root)}; start the app, then run init again`);
  if (!process.stdin.isTTY) fail("init asks questions, so it needs a terminal");
  if ((await init(target, all)) === "written") {
    apps = loadApps();
    const result = sync(apps, listeners());
    report(result);
    printRoutes(result, (instanceDir) => instanceDir === target.root);
  }
} else if (command === "add") {
  const { app, instance } = parseTarget(rest[0]);
  const port = Number(rest[1]);
  if (!Number.isInteger(port) || port <= 0) fail(`expected a port, got "${rest[1] ?? ""}"`);
  if (values["host-header"] && values["host-header"] !== "upstream") fail('--host-header only accepts "upstream"');
  const config = appByName(apps, app);
  const host = hostFor(config, values.host ?? "{instance}", instance);
  const all = listeners();
  const upstream = all.find((listener) => listener.port === port)?.upstream ?? `127.0.0.1:${port}`;
  const manual = loadManual();
  const entry = manual.find((item) => item.app === app && item.instance === instance) ?? {
    app,
    instance,
    source: "manual" as const,
    routes: [],
  };
  entry.routes = [
    ...entry.routes.filter((route) => route.host !== host),
    { host, upstream, ...(values["host-header"] ? { hostHeader: "upstream" as const } : {}) },
  ];
  saveManual([...manual.filter((item) => item !== entry), entry]);
  const result = sync(apps, all);
  report(result);
  printRoutes(result);
} else if (command === "rm") {
  const { app, instance } = parseTarget(rest[0]);
  const config = appByName(apps, app);
  const manual = loadManual();
  const entry = manual.find((item) => item.app === app && item.instance === instance);
  if (!entry) fail(`no hand-made routes for ${app}/${instance}; discovered ones disappear when the app stops`);
  const host = values.host ? hostFor(config, values.host, instance) : undefined;
  entry.routes = host ? entry.routes.filter((route) => route.host !== host) : [];
  saveManual(manual.filter((item) => item !== entry || item.routes.length > 0));
  const result = sync(apps, listeners());
  report(result);
  printRoutes(result);
} else if (command === "paths") {
  process.stdout.write(
    [
      `apps:      ${paths.apps}`,
      `state:     ${paths.state}`,
      `caddyfile: ${paths.caddyfile}`,
      `generated: ${generatedCaddyfile}`,
      `picker:    https://devhost.test`,
    ].join("\n") + "\n",
  );
} else {
  fail(`unknown command "${command}"\n\n${usage}`);
}
