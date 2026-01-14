import { RefObject, useCallback } from "react"

// This is a workaround for the react-window type issue.
// The library does not provide proper types for its components.
type VirtualList = {
    scrollToItem(index: number, align?: 'auto' | 'smart' | 'center' | 'end' | 'start'): void;
    props: {
        itemCount: number;
    }
}

/**
 * Hook untuk auto-scroll ke bawah pada react-window list
 */
export function useScrollToBottom(listRef: RefObject<VirtualList>) {
  const scrollToBottom = useCallback(() => {
    if (!listRef.current) return
    const lastIndex = listRef.current.props.itemCount - 1
    if (lastIndex >= 0) {
      listRef.current.scrollToItem(lastIndex, "end")
    }
  }, [listRef])

  return { scrollToBottom }
}
