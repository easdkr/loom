import type { Project } from "./project";

interface WorkdirSource {
  workdir?: string | null;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function joinPath(root: string, path: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${cleanRoot}/${cleanPath}`;
}

export function basename(path: string): string {
  const clean = path.replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : clean;
}

export function lastPathSegments(path: string, count = 2): string {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(Math.max(0, parts.length - count)).join("/") || path;
}

export function resolveWorkdir(source: WorkdirSource, project: Project | null): string | null {
  const raw = source.workdir?.trim();
  if (!project) {
    return raw || null;
  }
  if (!raw) {
    return project.root;
  }
  return isAbsolutePath(raw) ? raw : joinPath(project.root, raw);
}
