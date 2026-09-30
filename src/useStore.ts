import { useSyncExternalStore } from "react";
import { store } from "./store";

export function useStore() {
  useSyncExternalStore(store.subscribe, () => store.state);
  return store;
}
