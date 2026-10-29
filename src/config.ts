import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface RouteRule {
  command: string;
  host: string;
  hostHeader?: "upstream";
}

export interface AppConfig {
  name: string;
  domain: string;
  match: RegExp[];
  routes: RouteRule[];
}

interface AppFile {
  domain?: string;
  match?: string[];
  routes?: RouteRule[];
}

const home = homedir();

export const paths = {
  apps: join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "devhost", "apps"),
  state: join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "devhost"),
  caddyfile:
    process.env.DEVHOST_CADDYFILE ??
    ["/opt/homebrew/etc/Caddyfile", "/usr/local/etc/Caddyfile"].find((file) => existsSync(file)) ??
    "/opt/homebrew/etc/Caddyfile",
};

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

function globToRegExp(glob: string): RegExp {
  const pattern = expandHome(glob)
    .replace(/\/+$/, "")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${pattern}$`);
}

export function loadApps(): AppConfig[] {
  if (!existsSync(paths.apps)) return [];
  return readdirSync(paths.apps)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const name = basename(file, ".json");
      const data = JSON.parse(readFileSync(join(paths.apps, file), "utf8")) as AppFile;
      return {
        name,
        domain: data.domain ?? `${name}.test`,
        match: (data.match ?? []).map(globToRegExp),
        routes: data.routes ?? [],
      };
    });
}

export function appByName(apps: AppConfig[], name: string): AppConfig {
  return apps.find((app) => app.name === name) ?? { name, domain: `${name}.test`, match: [], routes: [] };
}
