import { Share } from "lucide-react";
import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function detectIOS(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function isStandaloneMode(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone ===
      true
  );
}

export function InstallPrompt() {
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("pwa-install-dismissed") === "true",
  );
  const [iosDismissed, setIosDismissed] = useState(
    () => localStorage.getItem("pwa-ios-install-dismissed") === "true",
  );

  const isIOS = detectIOS();
  const isInstalled = isStandaloneMode();

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const { outcome } = await installEvent.userChoice;
    if (outcome === "accepted") {
      setInstallEvent(null);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem("pwa-install-dismissed", "true");
    setDismissed(true);
  };

  const handleIosDismiss = () => {
    localStorage.setItem("pwa-ios-install-dismissed", "true");
    setIosDismissed(true);
  };

  // iOS instructional banner — only on iOS Safari, not already installed, not dismissed
  if (isIOS && !isInstalled && !iosDismissed) {
    return (
      <div className="fixed bottom-20 left-4 right-4 z-50 bg-card border border-primary/30 rounded-xl p-4 shadow-lg flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center shrink-0">
          <Share className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">
            Install this app
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Tap the <Share className="w-3 h-3 inline mb-0.5" /> Share button
            then &ldquo;Add to Home Screen&rdquo;
          </p>
        </div>
        <button
          type="button"
          onClick={handleIosDismiss}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 shrink-0"
          aria-label="Dismiss iOS install banner"
        >
          ✕
        </button>
      </div>
    );
  }

  // Android / desktop install prompt — only when beforeinstallprompt fired
  if (!installEvent || dismissed || isIOS) return null;

  return (
    <div className="fixed bottom-20 left-4 right-4 z-50 bg-card border border-primary/30 rounded-xl p-4 shadow-lg flex items-center gap-3">
      <img
        src="/icon-192.png"
        alt="App icon"
        className="w-10 h-10 rounded-lg shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground">
          Install Fantasy Auction
        </p>
        <p className="text-xs text-muted-foreground">
          Add to your home screen for the best experience
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={handleInstall}
          className="text-xs font-semibold text-primary border border-primary/40 rounded-lg px-3 py-1 hover:bg-primary/10"
        >
          Install
        </button>
      </div>
    </div>
  );
}
