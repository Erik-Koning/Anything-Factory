// The repository a team works on (TeamSettings.repo), which its lead publishes at a6g register from the remote its
// checkout pushes to: owner/name on GitHub, or a host and path. Nothing for a team published before it, or with no
// remote. What a lead publishes is its machine's word, so the name is plain text and the link goes only to a page on
// the web (http or https), never to whatever else an address could run.
import type { TeamDoc } from "../server/factory.ts";
import { clip } from "./ui.tsx";

const pageOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
};

// `link`: its page, where the repository has one; off in a fold's header, which is one key that opens the fold.
// `branch`: the team's integration branch, said after it.
export function TeamRepo({ repo, link = true, branch }: { repo: TeamDoc["repo"]; link?: boolean; branch?: string }) {
  if (!repo || typeof repo.name !== "string" || !repo.name) return null;
  const name = clip(repo.name, 120);
  const page = link ? pageOf(repo.url) : null;
  return (
    <span className="team-repo">
      {page ? (
        <a className="code" href={page} rel="noreferrer">
          {name}
        </a>
      ) : (
        <span className="code">{name}</span>
      )}
      {branch ? <span className="muted"> on {clip(branch, 100)}</span> : null}
    </span>
  );
}
