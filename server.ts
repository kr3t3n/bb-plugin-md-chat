// bb-plugin-md-chat — backend entry.
//
// The app's Markdown opener cannot read files by itself, so this backend
// resolves a file opener source (workspace, host or thread storage) to an
// absolute path on its host and reads it through bb.sdk.files.
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

const sourceSchema = z
  .object({
    kind: z.enum(["workspace", "host", "thread-storage"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().min(1).optional(),
  })
  .strict();
export type FileSource = z.infer<typeof sourceSchema>;

export const rpcContract = defineRpcContract({
  readFile: {
    input: z.object({ source: sourceSchema, path: z.string().min(1) }).strict(),
    output: z
      .object({
        content: z.string(),
        sha256: z.string(),
        // Root that local links in the document resolve against.
        rootPath: z.string(),
      })
      .strict(),
  },
});

interface ResolvedFile {
  absolutePath: string;
  rootPath: string;
  hostId: string | null;
}

/** A source-relative path that cannot climb out of its root. */
function requireRelativePath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Invalid relative path: ${raw}`);
  }
  return path.posix.normalize(normalized);
}

function isWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function joinOnHost(root: string, relative: string): string {
  return (isWindowsPath(root) ? path.win32 : path.posix).join(
    root,
    ...relative.split("/"),
  );
}

export default async function plugin(bb: BbPluginApi) {
  async function resolve(
    source: FileSource,
    filePath: string,
  ): Promise<ResolvedFile> {
    if (source.kind === "host") {
      if (!path.posix.isAbsolute(filePath) && !isWindowsPath(filePath)) {
        throw new Error("Host file paths must be absolute");
      }
      const flavor = isWindowsPath(filePath) ? path.win32 : path.posix;
      return {
        absolutePath: filePath,
        rootPath: flavor.dirname(filePath),
        hostId: source.experimental_hostId ?? null,
      };
    }
    if (source.kind === "workspace") {
      if (source.environmentId === null) {
        throw new Error("This workspace file has no environment");
      }
      const environment = await bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      if (!environment.path) {
        throw new Error("This environment has no workspace path");
      }
      return {
        absolutePath: joinOnHost(
          environment.path,
          requireRelativePath(filePath),
        ),
        rootPath: environment.path,
        hostId: environment.hostId ?? null,
      };
    }
    if (source.threadId === null) {
      throw new Error("Thread-storage files need a thread");
    }
    const location = await bb.sdk.threads.storageLocation({
      threadId: source.threadId,
    });
    if (!location.storageRootPath) {
      throw new Error("This thread has no storage path");
    }
    return {
      absolutePath: joinOnHost(
        location.storageRootPath,
        requireRelativePath(filePath),
      ),
      rootPath: location.storageRootPath,
      hostId: location.hostId ?? null,
    };
  }

  bb.rpc.register(rpcContract, {
    async readFile({ source, path: filePath }) {
      const file = await resolve(source, filePath);
      const result = await bb.sdk.files.read({
        path: file.absolutePath,
        rootPath: file.rootPath,
        ...(file.hostId !== null ? { hostId: file.hostId } : {}),
      });
      if (result.sizeBytes > MAX_FILE_BYTES) {
        throw new Error("The file is too large for the Markdown chat view");
      }
      const content =
        result.contentEncoding === "base64"
          ? Buffer.from(result.content, "base64").toString("utf8")
          : result.content;
      return { content, sha256: result.sha256, rootPath: file.rootPath };
    },
  });
}
