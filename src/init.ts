import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { globToRegExp, paths, type AppConfig, type RouteRule } from "./config.ts";
import { describeWorktree, discoverInstance, type Listener } from "./discover.ts";
import { nameSources, suggest, tilde, worktreePatterns, type Target } from "./setup.ts";

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function shorten(command: string, width = 100): string {
  if (command.length <= width) return command;
  const head = Math.floor(width / 3);
  return `${command.slice(0, head)}…${command.slice(command.length - (width - head - 1))}`;
}

export type InitOutcome = "written" | "cancelled";

export async function init(group: Target, all: Listener[]): Promise<InitOutcome> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const out = (text = "") => process.stdout.write(`${text}\n`);
  const ask = async (question: string, fallback: string) => (await rl.question(`${question} [${fallback}]: `)).trim() || fallback;

  try {
    out(`Processes listening in ${tilde(group.root)}:`);
    out();
    for (const listener of group.listeners) out(`  :${listener.port}  ${shorten(listener.command)}`);
    out();

    const sources = nameSources(group);
    out("Name suggestions, best first:");
    for (const source of sources) out(`  ${source.name}  (${source.from})`);
    let name = sources[0]?.name ?? "app";
    for (;;) {
      name = sanitize(await ask("App name", name));
      if (!name) continue;
      if (!existsSync(join(paths.apps, `${name}.json`))) break;
      out(`  ${name}.json already exists; pick another name or add these folders to its "match" by hand.`);
    }
    const domain = await ask("Domain", `${name}.test`);
    const match = (await ask("Instance folders", worktreePatterns(group).join(", ")))
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean);

    out();
    out("One rule per process. A rule matches a process whose command line contains its text.");
    out(`Enter keeps the suggestion, "-" leaves the process out. {instance} becomes the worktree name.`);
    const rules: RouteRule[] = [];
    for (const { listener, rule } of suggest(group)) {
      out();
      out(`  :${listener.port}  ${shorten(listener.command, 90)}`);
      let command: string;
      for (;;) {
        command = await ask("    command contains", rule.command);
        if (command === "-" || listener.command.includes(command)) break;
        out("    that text isn't in this process's command line");
      }
      if (command === "-") continue;
      const host = await ask("    hostname", rule.host);
      rules.push({ command, host, ...(rule.hostHeader && command === rule.command ? { hostHeader: rule.hostHeader } : {}) });
    }
    if (!rules.length) {
      out("No rules, nothing written.");
      return "cancelled";
    }

    const app: AppConfig = { name, domain, patterns: match, match: match.map(globToRegExp), routes: rules };
    const preview = discoverInstance(app, group.root, all);
    const { instance } = describeWorktree(group.root);
    out();
    out(`For this folder (instance "${instance}") that gives:`);
    for (const route of preview.routes) out(`  https://${route.host}  →  ${route.upstream}`);
    const unrouted = rules.length - preview.routes.length;
    if (unrouted > 0) out(`  (${unrouted} rule${unrouted > 1 ? "s" : ""} matched no free process; an earlier rule may have taken it)`);
    if (!match.some((pattern) => globToRegExp(pattern).test(group.root))) {
      out(`  Warning: ${tilde(group.root)} matches none of the folder patterns, so it won't be picked up.`);
    }

    const file = join(paths.apps, `${name}.json`);
    const body = { domain, match, routes: rules };
    out();
    out(`${tilde(file)}:`);
    out(JSON.stringify(body, null, 2));
    const confirm = (await rl.question("Write it? [Y/n]: ")).trim().toLowerCase();
    if (confirm === "n" || confirm === "no") return "cancelled";
    mkdirSync(paths.apps, { recursive: true });
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
    out(`Wrote ${tilde(file)}.`);
    return "written";
  } catch (error) {
    if ((error as { code?: string }).code !== "ABORT_ERR") throw error;
    out();
    out("Cancelled, nothing written.");
    return "cancelled";
  } finally {
    rl.close();
  }
}
