import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type { AppConfig } from "./config.ts";

export interface Listener {
  pid: number;
  port: number;
  upstream: string;
  command: string;
  cwd: string;
}

export interface Route {
  host: string;
  upstream: string;
  hostHeader?: "upstream";
}

export interface Instance {
  app: string;
  instance: string;
  source: "auto" | "manual";
  dir?: string;
  branch?: string;
  routes: Route[];
}

export function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? "");
  }
}

function upstreamFor(hosts: Set<string>, port: number): string {
  if (hosts.has("*") || hosts.has("0.0.0.0") || hosts.has("127.0.0.1")) return `127.0.0.1:${port}`;
  if (hosts.has("[::1]") || hosts.has("[::]")) return `[::1]:${port}`;
  return `localhost:${port}`;
}

export function listeners(): Listener[] {
  const sockets = new Map<string, { pid: number; port: number; hosts: Set<string> }>();
  let pid = 0;
  for (const line of run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) continue;
    const name = line.slice(1);
    const colon = name.lastIndexOf(":");
    const port = Number(name.slice(colon + 1));
    const key = `${pid}:${port}`;
    const socket = sockets.get(key) ?? { pid, port, hosts: new Set<string>() };
    socket.hosts.add(name.slice(0, colon));
    sockets.set(key, socket);
  }

  const pids = [...new Set([...sockets.values()].map((socket) => socket.pid))];
  if (pids.length === 0) return [];

  const cwds = new Map<number, string>();
  pid = 0;
  for (const line of run("lsof", ["-a", "-d", "cwd", "-F", "pn", "-p", pids.join(",")]).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("n")) cwds.set(pid, line.slice(1));
  }

  const commands = new Map<number, string>();
  for (const line of run("ps", ["-ww", "-o", "pid=,command=", "-p", pids.join(",")]).split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2] ?? "");
  }

  return [...sockets.values()].map(({ pid, port, hosts }) => ({
    pid,
    port,
    upstream: upstreamFor(hosts, port),
    command: commands.get(pid) ?? "",
    cwd: cwds.get(pid) ?? "",
  }));
}

export function findRoot(app: AppConfig, path: string): string | undefined {
  for (let dir = path; dir && dir !== "/"; dir = dirname(dir)) {
    if (app.match.some((pattern) => pattern.test(dir))) return dir;
  }
  return undefined;
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

export function describeWorktree(root: string): { instance: string; branch?: string } {
  const common = run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  const branch = run("git", ["-C", root, "branch", "--show-current"]).trim() || undefined;
  if (!common) return { instance: sanitize(basename(root)), branch };
  const mainRoot = basename(common) === ".git" ? dirname(common) : common;
  if (mainRoot === root) return { instance: "main", branch };
  const prefix = `${basename(mainRoot)}-`;
  const name = basename(root);
  return { instance: sanitize(name.startsWith(prefix) ? name.slice(prefix.length) : name), branch };
}

export function hostFor(app: AppConfig, template: string, instance: string): string {
  return `${template.replaceAll("{instance}", instance)}.${app.domain}`;
}

export function discoverInstance(app: AppConfig, root: string, all: Listener[]): Instance {
  const { instance, branch } = describeWorktree(root);
  const inside = all
    .filter((listener) => listener.cwd === root || listener.cwd.startsWith(`${root}/`))
    .sort((a, b) => a.port - b.port);
  const used = new Set<Listener>();
  const routes: Route[] = [];
  for (const rule of app.routes) {
    const listener = inside.find((candidate) => !used.has(candidate) && candidate.command.includes(rule.command));
    if (!listener) continue;
    used.add(listener);
    routes.push({ host: hostFor(app, rule.host, instance), upstream: listener.upstream, hostHeader: rule.hostHeader });
  }
  return { app: app.name, instance, source: "auto", dir: root, branch, routes };
}

export function discoverAll(apps: AppConfig[], all: Listener[]): Instance[] {
  const roots = new Map<string, AppConfig>();
  for (const listener of all) {
    for (const app of apps) {
      const root = findRoot(app, listener.cwd);
      if (root) roots.set(root, app);
    }
  }
  return [...roots]
    .map(([root, app]) => discoverInstance(app, root, all))
    .filter((instance) => instance.routes.length > 0);
}
