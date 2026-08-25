import { InternetIdentityProvider } from "@caffeineai/core-infrastructure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

BigInt.prototype.toJSON = function () {
  return this.toString();
};

declare global {
  interface BigInt {
    toJSON(): string;
  }
  interface Window {
    OneSignalDeferred?: Array<(OneSignal: any) => Promise<void>>;
  }
}

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <InternetIdentityProvider>
      <App />
    </InternetIdentityProvider>
  </QueryClientProvider>,
);

// OneSignal initialization
window.OneSignalDeferred = window.OneSignalDeferred || [];
window.OneSignalDeferred.push(async (OneSignal: any) => {
  await OneSignal.init({
    appId: "1b488a94-8768-4292-a6a9-64a9fd5329c3",
    serviceWorkerPath: "/OneSignalSDKWorker.js",
    notifyButton: { enable: false },
    allowLocalhostAsSecureOrigin: true,
  });
});
