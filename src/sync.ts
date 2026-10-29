import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appByName, paths, type AppConfig } from "./config.ts";
import { discoverAll, type Instance, type Listener } from "./discover.ts";

const manualFile = join(paths.state, "manual.json");
const siteDir = join(paths.state, "site");
const pickerSource = join(import.meta.dirname, "..", "site", "index.html");
export const generatedCaddyfile = join(dirname(paths.caddyfile), "caddy.d", "devhost.caddy");

function writeAtomic(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

export function loadManual(): Instance[] {
  if (!existsSync(manualFile)) return [];
  return JSON.parse(readFileSync(manualFile, "utf8")) as Instance[];
}

export function saveManual(instances: Instance[]) {
  writeAtomic(manualFile, `${JSON.stringify(instances, null, 2)}\n`);
}

export function portOf(upstream: string): number {
  return Number(upstream.slice(upstream.lastIndexOf(":") + 1));
}

export function merge(auto: Instance[], manual: Instance[]): Instance[] {
  const manualHosts = new Set(manual.flatMap((instance) => instance.routes.map((route) => route.host)));
  const result = auto
    .map((instance) => ({ ...instance, routes: instance.routes.filter((route) => !manualHosts.has(route.host)) }))
    .filter((instance) => instance.routes.length > 0);
  return [...result, ...manual].sort(
    (a, b) =>
      a.app.localeCompare(b.app) ||
      Number(b.instance === "main") - Number(a.instance === "main") ||
      a.instance.localeCompare(b.instance),
  );
}

function caddySite(hosts: string[], body: string[]): string {
  return [`${hosts.join(", ")} {`, ...body.map((line) => `\t${line}`), "}"].join("\n");
}

function renderCaddy(apps: AppConfig[], instances: Instance[]): string {
  const blocks = [
    caddySite(["devhost.test", ...apps.map((app) => app.domain)], [`root * ${siteDir}`, "header Cache-Control no-store", "file_server"]),
  ];
  for (const instance of instances) {
    for (const route of instance.routes) {
      const proxy =
        route.hostHeader === "upstream"
          ? [`reverse_proxy ${route.upstream} {`, "\theader_up Host {upstream_hostport}", "}"]
          : [`reverse_proxy ${route.upstream}`];
      blocks.push(caddySite([route.host], proxy));
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function writePicker(apps: AppConfig[], instances: Instance[], alive: Set<number>) {
  mkdirSync(siteDir, { recursive: true });
  copyFileSync(pickerSource, join(siteDir, "index.html"));
  const data = {
    generatedAt: new Date().toISOString(),
    apps: [...new Set([...apps.map((app) => app.name), ...instances.map((i) => i.app)])].map((name) => ({
      name,
      domain: appByName(apps, name).domain,
    })),
    instances: instances.map((instance) => ({
      ...instance,
      routes: instance.routes.map((route) => ({ ...route, alive: alive.has(portOf(route.upstream)) })),
    })),
  };
  writeAtomic(join(siteDir, "instances.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function reloadCaddy(): string | undefined {
  try {
    execFileSync("caddy", ["reload", "--config", paths.caddyfile, "--adapter", "caddyfile"], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    return undefined;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    const message = stderr
      .split("\n")
      .map((line) => {
        try {
          const entry = JSON.parse(line) as { level?: string; msg?: string; error?: string };
          return entry.error ?? (entry.level === "error" ? (entry.msg ?? "") : "");
        } catch {
          return line;
        }
      })
      .filter(Boolean)
      .join("\n");
    return message || stderr.trim() || String(error);
  }
}

export interface SyncResult {
  instances: Instance[];
  changed: boolean;
  error?: string;
}

export function sync(apps: AppConfig[], all: Listener[]): SyncResult {
  const instances = merge(discoverAll(apps, all), loadManual());
  writePicker(apps, instances, new Set(all.map((listener) => listener.port)));
  const caddy = renderCaddy(apps, instances);
  const previous = existsSync(generatedCaddyfile) ? readFileSync(generatedCaddyfile, "utf8") : "";
  if (caddy === previous) return { instances, changed: false };
  writeAtomic(generatedCaddyfile, caddy);
  const error = reloadCaddy();
  if (error) writeAtomic(generatedCaddyfile, previous);
  return { instances, changed: !error, error };
}
