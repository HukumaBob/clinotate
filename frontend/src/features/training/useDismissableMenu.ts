import { useEffect, type RefObject } from "react";

/** Shared behaviour of the ⋯ menus: focus moves to the first enabled item on
  open, and an outside mousedown closes the menu. `closeOnScroll` is for menus
  positioned with fixed coordinates captured at open time. */
export function useDismissableMenu(
  open: boolean,
  close: (refocus: boolean) => void,
  menu: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
  closeOnScroll = false,
) {
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onScroll = () => close(false);
    document.addEventListener("mousedown", onDown);
    if (closeOnScroll) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onScroll);
    }
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
