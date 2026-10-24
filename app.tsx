// bb-plugin-md-chat — frontend entry.
//
// Registers a Markdown file opener that renders the file with bb's Markdown
// component and shows a selection menu with "Add to chat" and "Reply in side
// chat", the same two actions the thread timeline offers. bb's own preview
// stays one click away, and it is the fallback when a file cannot be read.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import {
  Markdown,
  ThreadChat,
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type {
  JsonValue,
  MarkdownProps,
  PluginFileOpenerProps,
  PluginThreadPanelProps,
  ThreadChatMessageAction,
} from "@get-bb/plugin-sdk/app";
import type { FileSource, rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

const SIDE_CHAT_PANEL_ID = "file-side-chat";
const POLL_INTERVAL_MS = 4000;

// ---------------------------------------------------------------------------
// Side chat
// ---------------------------------------------------------------------------

interface SideChatParams {
  threadId: string;
  sourceThreadId: string;
  quote: string;
  filePath: string | null;
}

function parseSideChatParams(value: JsonValue | null): SideChatParams | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { threadId, sourceThreadId, quote, filePath } = value;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (typeof sourceThreadId !== "string" || sourceThreadId.length === 0) {
    return null;
  }
  return {
    threadId,
    sourceThreadId,
    quote: typeof quote === "string" ? quote : "",
    filePath: typeof filePath === "string" ? filePath : null,
  };
}

/** The anchor text the side chat agent sees: the selection and its file. */
function sideChatAnchor(quote: string, filePath: string | null): string {
  if (quote.length === 0) return "";
  return filePath === null
    ? quote
    : `${quote}\n\n(Selected from the file ${filePath}.)`;
}

/**
 * Starts a side chat through the built-in side-chat plugin, so the fork,
 * its hidden visibility and its cleanup stay the same as a timeline side chat.
 */
async function createSideChat(input: {
  sourceThreadId: string;
  anchorText: string;
}): Promise<string> {
  const response = await fetch("/api/v1/plugins/side-chat/rpc/createSideChat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json().catch(() => null);
  const result =
    typeof body === "object" && body !== null
      ? (body as { ok?: unknown; result?: unknown; error?: unknown })
      : null;
  if (!response.ok || result?.ok !== true) {
    const error = result?.error;
    const message =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : `Side chat failed (HTTP ${response.status})`;
    throw new Error(message);
  }
  const threadId = (result.result as { threadId?: unknown } | undefined)
    ?.threadId;
  if (typeof threadId !== "string") {
    throw new Error("The side chat plugin returned no thread");
  }
  return threadId;
}

function QuoteHeader({
  quote,
  filePath,
}: {
  quote: string;
  filePath: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  if (quote.trim().length === 0) return null;
  return (
    <div className="mx-1 mb-2 flex flex-col items-start gap-1">
      <span className="text-xs leading-none text-muted-foreground">
        <Icon
          name="CornerDownRight"
          className="mr-1 inline-block size-3 align-middle"
        />
        {filePath === null ? "Replying to" : `Replying to ${filePath}`}
      </span>
      <button
        type="button"
        className="max-w-full cursor-pointer rounded-md bg-surface-recessed p-1.5 text-left text-xs leading-5 text-foreground"
        title={expanded ? "Collapse" : "Show the full selection"}
        onClick={() => setExpanded((value) => !value)}
      >
        <div
          className={cn(
            "whitespace-pre-wrap break-words",
            !expanded && "max-h-20 overflow-hidden",
          )}
        >
          {quote}
        </div>
      </button>
    </div>
  );
}

function SideChatPanel({ params }: PluginThreadPanelProps) {
  const parsed = parseSideChatParams(params);
  const sourceThreadId = parsed?.sourceThreadId ?? null;
  const sideThreadId = parsed?.threadId ?? null;
  const sdk = useSdk();
  const sendToMain = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (sourceThreadId === null || sideThreadId === null || !trimmed) return;
      try {
        await sdk.threads.queuedMessages.create({
          threadId: sourceThreadId,
          input: [{ type: "text", text: trimmed, mentions: [] }],
          senderThreadId: sideThreadId,
        });
        toast.success("Sent to main thread");
      } catch (cause) {
        toast.error(
          `Failed to send to main thread: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    },
    [sdk, sourceThreadId, sideThreadId],
  );
  const messageActions = useMemo<ThreadChatMessageAction[]>(
    () => [
      {
        id: "send-to-main",
        title: "Send to main thread",
        icon: "ArrowTurnBackward",
        roles: ["assistant"],
        run: (message) => void sendToMain(message.text),
      },
    ],
    [sendToMain],
  );
  if (parsed === null) {
    return (
      <div className="p-3 text-sm text-muted-foreground" role="alert">
        Select text in a Markdown file to start a side chat.
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        threadId={parsed.threadId}
        variant="compact"
        layout="contained"
        permissionPolicy="editable"
        className="min-h-0 flex-1"
        leadingContent={
          <QuoteHeader quote={parsed.quote} filePath={parsed.filePath} />
        }
        messageActions={messageActions}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Selection menu
// ---------------------------------------------------------------------------

interface TextSelection {
  text: string;
  rect: DOMRect;
}

/** Tracks a non-empty text selection that lies inside `containerRef`. */
function useSelectionInside(
  containerRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
): [TextSelection | null, () => void] {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const clear = useCallback(() => setSelection(null), []);

  useEffect(() => {
    let frame: number | null = null;
    let pointerDown = false;

    const read = () => {
      frame = null;
      const container = containerRef.current;
      const current = window.getSelection();
      if (
        container === null ||
        current === null ||
        current.rangeCount === 0 ||
        current.isCollapsed
      ) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const text = current.toString().trim();
      if (text.length === 0) {
        setSelection(null);
        return;
      }
      setSelection({ text, rect: range.getBoundingClientRect() });
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(read);
    };
    const insideMenu = (target: EventTarget | null) =>
      target instanceof Node && menuRef.current?.contains(target) === true;

    const onPointerDown = (event: PointerEvent) => {
      if (insideMenu(event.target)) return;
      pointerDown = true;
      setSelection(null);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (insideMenu(event.target)) return;
      pointerDown = false;
      schedule();
    };
    const onSelectionChange = () => {
      if (!pointerDown) schedule();
    };
    const onScroll = () => {
      if (!pointerDown) schedule();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [containerRef, menuRef]);

  return [selection, clear];
}

interface MenuAction {
  icon: string;
  label: string;
  run: (text: string) => void | Promise<void>;
}

function SelectionMenu({
  selection,
  actions,
  menuRef,
  onDismiss,
}: {
  selection: TextSelection | null;
  actions: MenuAction[];
  menuRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}) {
  const portalScope = usePortalScopeProps();
  const rect = selection?.rect ?? null;
  // Show the menu above the selection unless that would leave the viewport.
  const side: "top" | "bottom" = rect !== null && rect.top < 56 ? "bottom" : "top";
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () =>
        rect === null
          ? new DOMRect(0, 0, 0, 0)
          : new DOMRect(
              rect.left + rect.width / 2,
              side === "top" ? rect.top : rect.bottom,
              0,
              0,
            ),
    }),
    [rect, side],
  );
  if (selection === null || actions.length === 0) return null;
  return (
    <Popover.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <Popover.Anchor virtualRef={{ current: anchor }} />
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          ref={menuRef}
          side={side}
          align="center"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={onDismiss}
          className="z-50 flex w-auto items-center gap-0.5 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md outline-none"
        >
          {actions.map((action, index) => (
            <div key={action.label} className="flex items-center">
              {index > 0 ? (
                <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
              ) : null}
              <button
                type="button"
                className="inline-flex cursor-pointer select-none items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                // Keep the document selection while the button takes the click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const text = selection.text;
                  onDismiss();
                  window.getSelection()?.removeAllRanges();
                  void Promise.resolve(action.run(text)).catch((cause) => {
                    toast.error(
                      cause instanceof Error ? cause.message : String(cause),
                    );
                  });
                }}
              >
                <Icon name={action.icon} className="size-3.5" />
                {action.label}
              </button>
            </div>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Markdown opener
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; content: string; sha256: string; rootPath: string }
  | { kind: "error"; message: string };

function useFileContent(source: FileSource, filePath: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const shaRef = useRef<string | null>(null);
  const sourceKey = JSON.stringify(source);

  const load = useCallback(
    async (background: boolean) => {
      try {
        const result = await rpc.call("readFile", {
          source: JSON.parse(sourceKey) as FileSource,
          path: filePath,
        });
        if (result.sha256 === shaRef.current) return;
        shaRef.current = result.sha256;
        setState({ kind: "ready", ...result });
      } catch (cause) {
        // A failed background poll keeps the last good content on screen.
        if (background && shaRef.current !== null) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [rpc, sourceKey, filePath],
  );

  useEffect(() => {
    shaRef.current = null;
    setState({ kind: "loading" });
    void load(false);
    const timer = window.setInterval(() => {
      // Poll only a file that loaded; the reload button retries a failed one.
      if (document.visibilityState === "visible" && shaRef.current !== null) {
        void load(true);
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { state, reload: () => void load(false) };
}

/** A short reason for the header; the full message stays in the tooltip. */
function describeLoadError(message: string): string {
  if (/does not exist|not found|ENOENT/i.test(message)) return "file not found";
  if (/too large/i.test(message)) return "file too large";
  return message.replace(/^(HTTP \d+:\s*)+/, "");
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "chat" | "bb";
  onChange: (value: "chat" | "bb") => void;
}) {
  const option = (key: "chat" | "bb", label: string, title: string) => (
    <button
      type="button"
      title={title}
      aria-pressed={value === key}
      onClick={() => onChange(key)}
      className={cn(
        "cursor-pointer rounded px-1.5 py-0.5 text-xs transition-colors",
        value === key
          ? "bg-state-active text-foreground"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-0.5">
      {option("chat", "Chat view", "Select text to add it to chat or a side chat")}
      {option("bb", "BB preview", "bb's own preview, with the raw source toggle")}
    </div>
  );
}

function MarkdownOpener({ path: filePath, source, Original }: PluginFileOpenerProps) {
  const context = useBbContext();
  const composer = useComposer();
  const navigate = useBbNavigate();
  const [view, setView] = useState<"chat" | "bb">("chat");
  const { state, reload } = useFileContent(source, filePath);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [selection, clearSelection] = useSelectionInside(contentRef, menuRef);
  const threadId = source.threadId ?? context.threadId;

  const actions = useMemo<MenuAction[]>(() => {
    const list: MenuAction[] = [
      {
        icon: "MessageSquarePlus",
        label: "Add to chat",
        run: (text) => {
          const quote = text
            .split("\n")
            .map((line) => (line.length > 0 ? `> ${line}` : ">"))
            .join("\n");
          composer.insert(`From \`${filePath}\`:\n${quote}\n`, {
            at: "end",
            block: true,
          });
          composer.focus();
        },
      },
    ];
    if (threadId !== null) {
      list.push({
        icon: "SideChat",
        label: "Reply in side chat",
        run: async (text) => {
          const sideThreadId = await createSideChat({
            sourceThreadId: threadId,
            anchorText: sideChatAnchor(text, filePath),
          });
          const opened = navigate.openThreadPanel({
            actionId: SIDE_CHAT_PANEL_ID,
            title: "Side chat",
            params: {
              threadId: sideThreadId,
              sourceThreadId: threadId,
              quote: text,
              filePath,
            },
          });
          if (!opened) throw new Error("bb could not open the side chat panel");
        },
      });
    }
    return list;
  }, [composer, filePath, navigate, threadId]);

  const documentProp = useMemo<MarkdownProps["experimental_document"]>(() => {
    if (state.kind !== "ready" || threadId === null) return undefined;
    if (source.kind === "workspace" && source.environmentId !== null) {
      return {
        threadId,
        rootPath: state.rootPath,
        target: { kind: "workspace", environmentId: source.environmentId, path: filePath },
      };
    }
    if (source.kind === "thread-storage" && source.threadId !== null) {
      return {
        threadId,
        rootPath: state.rootPath,
        target: { kind: "thread-storage", threadId: source.threadId, path: filePath },
      };
    }
    return undefined;
  }, [filePath, source, state, threadId]);

  let body: ReactNode;
  if (view === "bb" || state.kind === "error") {
    body = <Original />;
  } else if (state.kind === "loading") {
    body = <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  } else {
    body = (
      <div className="min-h-0 flex-1 overflow-auto" data-file-preview-scroll-container="">
        <div ref={contentRef} className="px-4 py-4">
          <Markdown
            content={state.content}
            {...(documentProp ? { experimental_document: documentProp } : {})}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={filePath}>
          {filePath}
        </span>
        {state.kind === "error" ? (
          <span
            className="min-w-0 max-w-[50%] truncate text-xs text-muted-foreground"
            title={state.message}
          >
            Chat view unavailable: {describeLoadError(state.message)}
          </span>
        ) : (
          <ViewToggle value={view} onChange={setView} />
        )}
        <button
          type="button"
          title="Reload the file"
          aria-label="Reload the file"
          onClick={reload}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="RotateCcw" className="size-3.5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      {view === "chat" ? (
        <SelectionMenu
          selection={selection}
          actions={actions}
          menuRef={menuRef}
          onDismiss={clearSelection}
        />
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "markdown-chat",
    title: "Markdown with chat",
    extensions: ["md", "markdown", "mdx"],
    component: MarkdownOpener,
  });
  app.slots.threadPanelAction({
    id: SIDE_CHAT_PANEL_ID,
    title: "File side chat",
    icon: "SideChat",
    layout: "flush",
    component: SideChatPanel,
  });
});
