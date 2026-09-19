import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch {
            return window.localStorage.getItem(name);
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};

// Canvas drafts must fail visibly when IndexedDB fails. A successful localStorage
// fallback can otherwise leave a newer draft hidden behind an older IndexedDB copy.
export const canvasPersistenceStorage = {
    getItem: async (name: string) => typeof window === "undefined" ? null : (await localforage.getItem<string>(name)) ?? window.localStorage.getItem(name),
    setItem: async (name: string, value: string) => { if (typeof window !== "undefined") await localforage.setItem(name, value); },
    removeItem: async (name: string) => { if (typeof window !== "undefined") { await localforage.removeItem(name); window.localStorage.removeItem(name); } },
    keys: async () => typeof window === "undefined" ? [] : localforage.keys(),
};
