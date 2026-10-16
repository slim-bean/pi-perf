import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/** One pending disk operation; slow disks drop records, never build a queue. */
export class RotatingLog {
  readonly path: string;
  dropped = 0;
  failed = false;
  private handle?: FileHandle;
  private size = 0;
  private pending?: Promise<void>;
  private closed = false;

  constructor(private dir: string, filename: string, private maxBytes: number) {
    this.path = join(dir, filename);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    this.handle = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    await this.handle.chmod(0o600);
    this.size = (await this.handle.stat()).size;
  }

  write(record: unknown): void {
    if (this.closed || this.failed) return;
    if (this.pending) { this.dropped++; return; }
    const line = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(line) > this.maxBytes) { this.dropped++; return; }
    this.pending = this.append(line).catch(() => { this.failed = true; })
      .finally(() => { this.pending = undefined; });
  }

  private async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      await this.handle?.close();
      this.handle = undefined;
      await rm(this.path + ".2", { force: true });
      for (const [from, to] of [[this.path + ".1", this.path + ".2"], [this.path, this.path + ".1"]]) {
        try { await rename(from!, to!); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.handle = await open(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      await chmod(this.path, 0o600);
      this.size = 0;
    }
    await this.handle!.writeFile(line);
    this.size += bytes;
  }

  async flush(): Promise<void> { await this.pending; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.handle?.close();
    this.handle = undefined;
  }
}
