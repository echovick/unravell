import simpleGit, { SimpleGit } from "simple-git";
import type { GitChange } from "../shared/types";

export class GitAnalyzer {
  private git: SimpleGit;

  constructor(projectRoot: string) {
    this.git = simpleGit(projectRoot);
  }

  /**
   * Get the last N commits that touched a specific file.
   */
  async getFileHistory(filepath: string, count = 5): Promise<GitChange[]> {
    try {
      const log = await this.git.log({
        file: filepath,
        maxCount: count,
        "--diff-filter": "M",
      });

      const changes: GitChange[] = [];

      for (const entry of log.all) {
        let diff = "";
        try {
          diff = await this.git.diff([`${entry.hash}~1`, entry.hash, "--", filepath]);
          // Abbreviate long diffs
          if (diff.length > 2000) {
            diff = diff.slice(0, 2000) + "\n... (truncated)";
          }
        } catch {
          // First commit won't have a parent
        }

        changes.push({
          hash: entry.hash,
          message: entry.message,
          author: entry.author_name,
          date: entry.date,
          diff,
          filesChanged: [], // populated below if needed
        });
      }

      return changes;
    } catch {
      return [];
    }
  }

  /**
   * Get the last N project-wide commits.
   */
  async getRecentCommits(count = 20): Promise<GitChange[]> {
    try {
      const log = await this.git.log({ maxCount: count });

      return log.all.map((entry) => ({
        hash: entry.hash,
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
        diff: entry.diff?.files?.map((f: any) => f.file).join(", ") ?? "",
        filesChanged: [],
      }));
    } catch {
      return [];
    }
  }

  /**
   * Get the last modified date and author for a file.
   */
  async getLastModified(filepath: string): Promise<{ date: string; author: string }> {
    try {
      const log = await this.git.log({ file: filepath, maxCount: 1 });
      const entry = log.latest;
      if (entry) {
        return { date: entry.date, author: entry.author_name };
      }
    } catch {
      // ignore
    }
    return { date: "", author: "" };
  }
}
