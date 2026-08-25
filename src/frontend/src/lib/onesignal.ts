function getPushSubscriptionId(OneSignal: any): Promise<string | null> {
  return new Promise((resolve) => {
    const existing = OneSignal.User?.PushSubscription?.id;
    if (existing) {
      resolve(existing);
      return;
    }
    const listener = (event: any) => {
      const id = event?.current?.id;
      if (id) {
        clearTimeout(timeout);
        OneSignal.User.PushSubscription.removeEventListener("change", listener);
        resolve(id);
      }
    };
    const timeout = setTimeout(() => {
      OneSignal.User.PushSubscription.removeEventListener("change", listener);
      resolve(OneSignal.User?.PushSubscription?.id ?? null);
    }, 15000);
    OneSignal.User.PushSubscription.addEventListener("change", listener);
  });
}

export async function storeOneSignalPlayerId(actor: any): Promise<void> {
  if (!window.OneSignalDeferred) return;
  window.OneSignalDeferred.push(async (OneSignal: any) => {
    try {
      const playerId = await getPushSubscriptionId(OneSignal);
      if (playerId && actor) {
        await actor.setOneSignalPlayerId(playerId);
      }
    } catch {
      // silent — non-critical
    }
  });
}

export function requestNotificationPermission(): Promise<void> {
  return new Promise((resolve) => {
    if (!window.OneSignalDeferred) {
      resolve();
      return;
    }
    window.OneSignalDeferred.push(async (OneSignal: any) => {
      try {
        await OneSignal.Notifications?.requestPermission();
      } catch {
        // silent
      } finally {
        resolve();
      }
    });
  });
}
