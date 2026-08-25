import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInternetIdentity } from "@caffeineai/core-infrastructure";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";
import { GiphyFetch } from "@giphy/js-fetch-api";
import { Grid } from "@giphy/react-components";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, Smile, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useBackend } from "../hooks/useBackend";
import { useMessages, useSendMessage } from "../hooks/useRoomPolling";
import type { ParticipantView, RoomId } from "../types";
import { AvatarThumb } from "./AvatarThumb";
// ChatMessage.id is optional (?Text) — augment locally until bindgen regenerates types
type ChatMessageWithId = { id?: [] | [string] };

interface ChatPanelProps {
  roomId: RoomId;
  participants?: ParticipantView[];
  currentUserDisplayName?: string | null;
}

function getUsernameColor(name: string): string {
  const hash = Array.from(name).reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const palette = [
    "text-emerald-400",
    "text-violet-400",
    "text-amber-400",
    "text-rose-400",
    "text-sky-400",
  ];
  return palette[hash % palette.length];
}

/** Parse message text and return segments with @mention highlighting. */
function renderMessageWithMentions(
  text: string,
  mentionNames: Set<string>,
): React.ReactNode {
  // Split on @Word tokens, preserving delimiters
  const parts = text.split(/(@@?[\w .'-]+)/g);
  return parts.map((part) => {
    if (part.startsWith("@")) {
      const name = part.slice(1);
      if (mentionNames.has(name)) {
        return (
          <span
            key={`mention-${name}-${part}`}
            className="text-primary font-semibold"
            aria-label={`Mention: ${name}`}
          >
            {part}
          </span>
        );
      }
    }
    return part;
  });
}

function formatTimestamp(ts: bigint): string {
  const ms = Number(ts / BigInt(1_000_000));
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const GIF_PREFIX = "__gif__:";

function isGifMessage(content: string): boolean {
  return content.startsWith(GIF_PREFIX);
}

function extractGifUrl(content: string): string {
  return content.slice(GIF_PREFIX.length);
}

export function ChatPanel({
  roomId,
  participants = [],
  currentUserDisplayName,
}: ChatPanelProps) {
  const { actor } = useBackend();
  const queryClient = useQueryClient();
  const { identity } = useInternetIdentity();
  const currentPrincipalStr = identity?.getPrincipal()?.toText() ?? null;
  const { messages } = useMessages(roomId);
  const sendMessage = useSendMessage(roomId);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifSearch, setGifSearch] = useState("");
  const [debouncedGifSearch, setDebouncedGifSearch] = useState("");
  const [giphyFetch, setGiphyFetch] = useState<GiphyFetch | null>(null);
  const [isGiphyKeyLoading, setIsGiphyKeyLoading] = useState(true);
  const [pickerOpenFor, setPickerOpenFor] = useState<bigint | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const hasMountedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const gifPickerRef = useRef<HTMLDivElement>(null);
  const gifDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [longPressTarget, setLongPressTarget] = useState<bigint | null>(null);
  const [showSystemMessages, setShowSystemMessages] = useState(true);

  const avatarMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of participants ?? []) {
      m.set(p.userId.toText(), p.avatarUrl ?? null);
    }
    return m;
  }, [participants]);

  // @mention autocomplete state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // null = closed
  const [mentionIndex, setMentionIndex] = useState(0);

  // Set of all participant display names for mention highlighting
  const participantNames = new Set(participants.map((p) => p.displayName));

  // Filtered participant list for autocomplete dropdown
  const mentionResults =
    mentionQuery === null
      ? []
      : participants.filter((p) =>
          p.displayName.toLowerCase().startsWith(mentionQuery.toLowerCase()),
        );

  // Capture near-bottom state BEFORE new messages render
  const msgCount = messages.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — capture before DOM update
  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    wasNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, [msgCount]);

  // Scroll to latest message: always on first mount, only when near bottom on subsequent arrivals
  // Uses direct scrollTop manipulation to avoid scrollIntoView scrolling the wrong container
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — msgCount triggers scroll
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!hasMountedRef.current) {
      // First mount: always scroll to bottom instantly
      el.scrollTop = el.scrollHeight;
      hasMountedRef.current = true;
    } else if (wasNearBottomRef.current) {
      // Subsequent arrivals: only scroll if near bottom
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [msgCount]);

  // Debounce GIF search
  useEffect(() => {
    if (gifDebounceRef.current) clearTimeout(gifDebounceRef.current);
    gifDebounceRef.current = setTimeout(
      () => setDebouncedGifSearch(gifSearch),
      400,
    );
    return () => {
      if (gifDebounceRef.current) clearTimeout(gifDebounceRef.current);
    };
  }, [gifSearch]);

  // Close pickers when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target as Node)
      ) {
        setShowEmojiPicker(false);
      }
      if (
        gifPickerRef.current &&
        !gifPickerRef.current.contains(e.target as Node)
      ) {
        setShowGifPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Fetch Giphy key from backend on mount — available to all authenticated users
  useEffect(() => {
    if (!actor) return;
    void (async () => {
      try {
        const res = await actor.getGiphyApiKey();
        const key = res ?? null;
        setGiphyFetch(key && key.length > 0 ? new GiphyFetch(key) : null);
      } catch {
        setGiphyFetch(null);
      } finally {
        setIsGiphyKeyLoading(false);
      }
    })();
  }, [actor]);

  // Close reaction picker on outside click
  useEffect(() => {
    if (pickerOpenFor === null) return;
    const close = () => setPickerOpenFor(null);
    document.addEventListener("click", close, true);
    return () => document.removeEventListener("click", close, true);
  }, [pickerOpenFor]);

  const REACTION_EMOJIS = ["👍", "👎", "🔥", "😂", "😮", "💯", "💩"];

  const toggleReaction = async (messageId: bigint, emoji: string) => {
    if (!actor || roomId === null) return;
    setPickerOpenFor(null); // close picker immediately on selection
    try {
      const result = await actor.toggleMessageReaction(
        roomId,
        messageId,
        emoji,
      );
      if ("err" in result) {
        console.error("toggleMessageReaction error:", result.err);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["messages", roomId] });
    } catch (e) {
      console.error("toggleMessageReaction threw:", e);
    }
  };

  const startLongPress = (messageId: bigint) => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    setLongPressTarget(messageId);
    longPressTimerRef.current = setTimeout(() => {
      setPickerOpenFor(messageId);
      setLongPressTarget(null);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    setLongPressTarget(null);
  };

  // NOTE: Do NOT auto-focus the input on mount — causes keyboard popup on mobile.

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setSendError(null);
    setSending(true);
    // Optimistically mark as near-bottom so the refetch scroll effect fires
    wasNearBottomRef.current = true;
    try {
      await sendMessage(trimmed);
      setInput("");
      // Force scroll to bottom immediately after send, regardless of refetch timing
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setSending(false);
    }
  };

  /** Detect @mention trigger as user types */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInput(val);

    // Find the @word fragment at/before the cursor
    const cursor = e.target.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursor);
    const atMatch = textBeforeCursor.match(/@([\w .]*)$/);
    if (atMatch) {
      setMentionQuery(atMatch[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  /** Insert @DisplayName at the @ position in the input */
  const insertMention = (displayName: string) => {
    const el = inputRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? input.length;
    const textBeforeCursor = input.slice(0, cursor);
    const atIdx = textBeforeCursor.lastIndexOf("@");
    if (atIdx === -1) return;
    const before = input.slice(0, atIdx);
    const after = input.slice(cursor);
    const newVal = `${before}@${displayName} ${after}`;
    setInput(newVal);
    setMentionQuery(null);
    // Restore cursor after inserted mention
    requestAnimationFrame(() => {
      el.focus();
      const pos = atIdx + displayName.length + 2; // @Name + space
      el.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Handle mention dropdown keyboard navigation
    if (mentionQuery !== null && mentionResults.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        insertMention(mentionResults[mentionIndex].displayName);
        return;
      }
      if (e.key === "Escape") {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Insert emoji at cursor position
  const handleEmojiSelect = (emoji: { native?: string }) => {
    if (!emoji.native) return;
    const el = inputRef.current;
    if (el) {
      const start = el.selectionStart ?? input.length;
      const end = el.selectionEnd ?? input.length;
      const newValue = input.slice(0, start) + emoji.native + input.slice(end);
      setInput(newValue);
      // Restore cursor after emoji
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(
          start + emoji.native!.length,
          start + emoji.native!.length,
        );
      });
    } else {
      setInput((prev) => prev + emoji.native);
    }
    setShowEmojiPicker(false);
  };

  // Send a selected GIF
  const handleGifSelect = async (gif: {
    images: { original: { url: string } };
  }) => {
    setShowGifPicker(false);
    setSendError(null);
    setSending(true);
    try {
      const gifUrl = gif.images.original.url;
      await sendMessage(`${GIF_PREFIX}${gifUrl}`);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send GIF");
    } finally {
      setSending(false);
    }
  };

  // Giphy fetch function — trending or search
  const fetchGifs = (offset: number) => {
    if (!giphyFetch)
      return giphyFetch as unknown as ReturnType<GiphyFetch["trending"]>;
    if (debouncedGifSearch.trim()) {
      return giphyFetch.search(debouncedGifSearch, { offset, limit: 10 });
    }
    return giphyFetch.trending({ offset, limit: 10 });
  };

  // Messages come newest-first from backend; reverse to show oldest at top
  const chronological = [...messages].reverse();

  // Filter system messages based on per-session toggle (still counted toward unread badge)
  const displayedMessages = chronological.filter(
    (msg) => showSystemMessages || msg.displayName !== "System",
  );

  return (
    <div
      className="flex flex-col h-full min-h-0 bg-card border border-border/60 rounded-xl overflow-hidden"
      data-ocid="chat-panel"
    >
      {/* Chat header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card/90 shrink-0">
        <MessageCircle className="w-4 h-4 text-primary" />
        <span className="text-xs font-mono font-semibold uppercase tracking-wider text-foreground">
          Room Chat
        </span>
        {messages.length > 0 && (
          <span className="text-[10px] text-muted-foreground font-mono ml-1">
            ({messages.length})
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowSystemMessages((prev) => !prev)}
          className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
            showSystemMessages
              ? "border-primary/40 text-primary bg-primary/10"
              : "border-border/40 text-muted-foreground bg-muted/20"
          }`}
          data-ocid="chat-system-messages-toggle"
        >
          {showSystemMessages ? "Events On" : "Events Off"}
        </button>
      </div>

      {/* Messages list — solid dark background */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3 min-h-0 bg-background"
        data-ocid="chat-messages"
      >
        {displayedMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[120px] gap-2">
            <MessageCircle className="w-7 h-7 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground text-center">
              No messages yet. Say hello!
            </p>
          </div>
        ) : (
          displayedMessages.map((msg, i) => {
            const isSystemMsg = msg.displayName === "System";
            const isCommissionerNote = msg.message.includes("📌 Commissioner:");
            const systemText = msg.message;
            if (isSystemMsg) {
              return (
                <div
                  key={
                    (msg as unknown as ChatMessageWithId).id?.[0] ??
                    `${msg.timestamp.toString()}-${i}`
                  }
                  className={`mx-2 my-1 px-3 py-1.5 rounded-md flex items-center gap-2 ${isCommissionerNote ? "bg-primary/10 border border-primary/30" : "bg-muted/20 border border-border/30"}`}
                >
                  <span
                    className={`text-[10px] font-mono px-1 py-0.5 rounded shrink-0 ${isCommissionerNote ? "bg-primary/20 text-primary" : "bg-muted/40 text-muted-foreground"}`}
                  >
                    {isCommissionerNote ? "📌" : "⚙"}
                  </span>
                  <span
                    className={`flex-1 text-sm italic ${isCommissionerNote ? "text-foreground/80" : "text-muted-foreground"}`}
                  >
                    {systemText}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 shrink-0">
                    {formatTimestamp(msg.timestamp)}
                  </span>
                </div>
              );
            }
            return (
              <div
                key={msg.id.toString()}
                className="space-y-0.5"
                data-ocid="chat-message-row"
              >
                <div className="relative group">
                  <div className="flex items-baseline gap-1.5">
                    <AvatarThumb
                      avatarUrl={avatarMap.get(msg.userId.toText()) ?? null}
                      seed={msg.userId.toText()}
                      displayName={msg.displayName}
                      size={20}
                    />
                    <span
                      className={`text-sm font-semibold truncate max-w-[150px] ${
                        msg.displayName === currentUserDisplayName
                          ? "text-primary"
                          : getUsernameColor(msg.displayName)
                      }`}
                    >
                      {msg.displayName}
                    </span>
                    <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                      {formatTimestamp(msg.timestamp)}
                    </span>
                  </div>
                  {isGifMessage(msg.message) ? (
                    <img
                      src={extractGifUrl(msg.message)}
                      alt="GIF"
                      className="max-w-[200px] max-h-[200px] object-contain rounded-lg"
                      loading="lazy"
                    />
                  ) : (
                    <p
                      className="text-sm text-foreground/90 leading-snug break-words bg-card rounded px-2 py-1 inline-block max-w-full select-none"
                      onTouchStart={(e) => {
                        e.preventDefault();
                        startLongPress(msg.id);
                      }}
                      onTouchEnd={cancelLongPress}
                      onTouchMove={cancelLongPress}
                      onMouseDown={(e) => {
                        if (e.button === 2) return;
                        startLongPress(msg.id);
                      }}
                      onMouseUp={cancelLongPress}
                      onMouseLeave={cancelLongPress}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setPickerOpenFor(msg.id);
                      }}
                      style={{
                        backgroundColor:
                          longPressTarget === msg.id
                            ? "rgba(255,255,255,0.08)"
                            : undefined,
                      }}
                    >
                      {renderMessageWithMentions(msg.message, participantNames)}
                    </p>
                  )}
                  <button
                    type="button"
                    className="absolute -top-1 right-0 opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5 flex items-center justify-center text-xs bg-muted border border-border/50 rounded-full text-muted-foreground hover:text-foreground z-10"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPickerOpenFor(
                        pickerOpenFor === msg.id ? null : msg.id,
                      );
                    }}
                    data-ocid="chat-reaction-open-button"
                  >
                    +
                  </button>
                  {pickerOpenFor === msg.id && (
                    <div className="flex items-center gap-1 p-1 bg-popover border border-border rounded-lg shadow-lg absolute bottom-full mb-1 right-0 z-20">
                      {REACTION_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="text-base hover:scale-125 transition-transform p-0.5 rounded"
                          onClick={async (e) => {
                            e.stopPropagation();
                            await toggleReaction(msg.id, emoji);
                            setPickerOpenFor(null);
                          }}
                          data-ocid={`chat-reaction-emoji.${emoji}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {msg.reactions && msg.reactions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 ml-2">
                    {msg.reactions.map(([emoji, userIds]) => {
                      const userReacted = currentPrincipalStr
                        ? userIds.some(
                            (uid) => uid.toText() === currentPrincipalStr,
                          )
                        : false;
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={async () => {
                            await toggleReaction(msg.id, emoji);
                          }}
                          className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full border transition-colors ${
                            userReacted
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "border-border/40 bg-muted/30 text-muted-foreground hover:bg-muted/50"
                          }`}
                        >
                          {emoji} {userIds.length}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area — no background image */}
      <div className="shrink-0 border-t border-border px-3 py-2.5 bg-card/95 relative">
        {/* Emoji picker */}
        {showEmojiPicker && (
          <div
            ref={emojiPickerRef}
            className="absolute bottom-full right-0 mb-2 z-50 shadow-xl rounded-xl overflow-hidden"
            data-ocid="chat-emoji-picker"
          >
            <Picker
              data={data}
              onEmojiSelect={handleEmojiSelect}
              theme="dark"
              set="native"
              previewPosition="none"
              skinTonePosition="none"
            />
          </div>
        )}

        {/* GIF picker */}
        {showGifPicker && (
          <div
            ref={gifPickerRef}
            className="absolute bottom-full left-0 mb-2 z-50 w-80 max-w-[90vw] bg-card border border-border rounded-xl shadow-xl overflow-hidden flex flex-col"
            data-ocid="chat-gif-picker"
          >
            <div className="flex items-center gap-2 p-2 border-b border-border">
              <Input
                value={gifSearch}
                onChange={(e) => setGifSearch(e.target.value)}
                placeholder="Search GIFs…"
                className="h-8 text-sm flex-1"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowGifPicker(false)}
                className="text-muted-foreground hover:text-foreground shrink-0"
                aria-label="Close GIF picker"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto max-h-64 scrollbar-thin p-1">
              <Grid
                key={debouncedGifSearch}
                fetchGifs={fetchGifs}
                width={300}
                columns={2}
                gutter={4}
                noLink
                onGifClick={(gif, e) => {
                  e.preventDefault();
                  handleGifSelect(
                    gif as { images: { original: { url: string } } },
                  );
                }}
              />
            </div>
          </div>
        )}

        <div className="flex gap-2 items-center">
          {/* Emoji button */}
          <button
            type="button"
            onClick={() => {
              setShowEmojiPicker((v) => !v);
              setShowGifPicker(false);
            }}
            className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
            aria-label="Open emoji picker"
            data-ocid="chat-emoji-btn"
          >
            <Smile className="w-5 h-5" />
          </button>

          {/* GIF button — only shown after key fetch resolves and giphyFetch is initialized */}
          {!isGiphyKeyLoading && giphyFetch !== null && (
            <button
              type="button"
              onClick={() => {
                setShowGifPicker((v) => !v);
                setShowEmojiPicker(false);
              }}
              className="shrink-0 text-[10px] font-bold tracking-widest border border-border/60 rounded px-1.5 py-0.5 text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors"
              aria-label="Open GIF picker"
              data-ocid="chat-gif-btn"
            >
              GIF
            </button>
          )}

          {/* @mention autocomplete dropdown */}
          {mentionQuery !== null && mentionResults.length > 0 && (
            <div
              ref={mentionDropdownRef}
              className="absolute bottom-full left-0 mb-1 w-56 max-h-48 overflow-y-auto bg-card border border-border rounded-xl shadow-xl z-50 py-1"
              data-ocid="chat-mention-dropdown"
            >
              {mentionResults.map((p, idx) => (
                <button
                  key={p.userId.toText()}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus on input
                    insertMention(p.displayName);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm truncate transition-colors ${
                    idx === mentionIndex
                      ? "bg-primary/20 text-primary font-semibold"
                      : "text-foreground hover:bg-muted/50"
                  }`}
                  data-ocid={`chat-mention-item.${idx + 1}`}
                >
                  @{p.displayName}
                </button>
              ))}
            </div>
          )}

          <Input
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // Delay so mousedown on dropdown fires first
              setTimeout(() => setMentionQuery(null), 150);
            }}
            placeholder="Type a message…"
            className="h-9 text-sm text-black bg-background/60 border-border/60 flex-1 min-w-0"
            maxLength={500}
            disabled={sending}
            data-ocid="chat-input"
          />
          <Button
            type="button"
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="h-9 w-9 p-0 shrink-0 bg-primary/20 hover:bg-primary/30 text-primary border border-primary/40"
            aria-label="Send message"
            data-ocid="chat-send-btn"
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {sendError && (
        <p className="text-[10px] text-destructive px-3 pb-1.5 shrink-0 bg-card/95">
          {sendError}
        </p>
      )}
    </div>
  );
}
