import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize } from "node:path";
import { run, type Listener } from "./discover.ts";
import type { RouteRule } from "./config.ts";

export interface Target {
  root: string;
  mainRoot: string;
  branch?: string;
  listeners: Listener[];
}

export interface Suggestion {
  listener: Listener;
  rule: RouteRule;
}

const home = homedir();
const frontends = ["vite", "next", "nuxt", "astro", "webpack", "webpack-dev-server", "react-scripts", "parcel", "remix"];
const needsHostHeader = ["vite", "webpack", "webpack-dev-server"];
export function tilde(path: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function targetFor(dir: string, all: Listener[]): Target | undefined {
  const [root, common] = run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])
    .trim()
    .split("\n");
  if (!root || !common) return undefined;
  return {
    root,
    mainRoot: basename(common) === ".git" ? dirname(common) : common,
    branch: run("git", ["-C", root, "branch", "--show-current"]).trim() || undefined,
    listeners: all
      .filter((listener) => listener.cwd === root || listener.cwd.startsWith(`${root}/`))
      .sort((a, b) => a.port - b.port),
  };
}

export interface NameSource {
  name: string;
  from: string;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function remoteProject(root: string): { name: string; url: string } | undefined {
  const remotes = run("git", ["-C", root, "remote"]).trim().split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) return undefined;
  const url = run("git", ["-C", root, "remote", "get-url", remote]).trim();
  const name = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
  return name ? { name, url } : undefined;
}

export function nameSources(group: Target): NameSource[] {
  const remote = remoteProject(group.root);
  const sources = [
    remote ? { name: slug(remote.name), from: `remote ${remote.url}` } : undefined,
    { name: slug(basename(group.mainRoot)), from: `main worktree ${tilde(group.mainRoot)}` },
    { name: slug(basename(group.root)), from: `this worktree ${tilde(group.root)}` },
  ].filter((source): source is NameSource => Boolean(source?.name));
  return sources.filter((source, index) => sources.findIndex((other) => other.name === source.name) === index);
}

export function worktreePatterns(group: Target): string[] {
  const mainName = basename(group.mainRoot);
  const linked = run("git", ["-C", group.root, "worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path !== group.mainRoot);
  const patterns = [group.mainRoot, join(dirname(group.mainRoot), `${mainName}-*`)];
  for (const path of linked) {
    patterns.push(basename(path).startsWith(`${mainName}-`) ? join(dirname(path), `${mainName}-*`) : join(dirname(path), "*"));
  }
  return [...new Set(patterns)].map(tilde);
}

function packageName(path: string): string | undefined {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("node_modules/");
  if (index < 0) return undefined;
  const [scope, name] = normalized.slice(index + "node_modules/".length).split("/");
  return scope?.startsWith("@") && name ? `${scope}/${name}` : scope;
}

function relative(path: string, root: string): string {
  const inside = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const trimmed = inside.replace(/^\.\//, "");
  const src = trimmed.indexOf("/src/");
  return src > 0 ? trimmed.slice(0, src) : trimmed;
}

export function commandToken(listener: Listener, root: string): string {
  const [executable = "", ...args] = listener.command.split(/\s+/).filter(Boolean);
  const candidates = args.filter((arg) => !arg.startsWith("-") && !/^\d+$/.test(arg) && !arg.includes("://"));
  const pathLike = candidates.find((arg) => /[/.]/.test(arg) && !arg.includes("node_modules"));
  if (pathLike) return relative(pathLike, root);
  const packages = candidates.map(packageName).filter((name): name is string => Boolean(name));
  if (packages.length) return packages[packages.length - 1]!;
  if (candidates[0]) return candidates[0];
  return executable.startsWith(`${root}/`) ? relative(executable, root) : basename(executable);
}

function hostLabel(token: string): string {
  const last = basename(token, extname(token));
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";
}

export function suggest(group: Target): Suggestion[] {
  const tokens = group.listeners.map((listener) => ({ listener, token: commandToken(listener, group.root) }));
  const ordered = [
    ...tokens.filter(({ token }) => frontends.includes(token)),
    ...tokens.filter(({ token }) => !frontends.includes(token)),
  ];
  const used = new Set<string>();
  return ordered.map(({ listener, token }, index) => {
    const base = index === 0 ? "{instance}" : `${hostLabel(token)}.{instance}`;
    let host = base;
    for (let n = 2; used.has(host); n++) host = index === 0 ? `${n}.{instance}` : `${hostLabel(token)}-${n}.{instance}`;
    used.add(host);
    return {
      listener,
      rule: { command: token, host, ...(needsHostHeader.includes(token) ? { hostHeader: "upstream" as const } : {}) },
    };
  });
}
