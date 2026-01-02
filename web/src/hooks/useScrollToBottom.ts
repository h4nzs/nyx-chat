import { RefObject, useCallback } from "react"

/**
 * Hook untuk auto-scroll ke bawah pada react-window list
 */
export function useScrollToBottom(listRef: RefObject<any>) {
  const scrollToBottom = useCallback(() => {
    if (!listRef.current) return
    const lastIndex = listRef.current.props.itemCount - 1
    if (lastIndex >= 0) {
      listRef.current.scrollToItem(lastIndex, "end")
    }
  }, [listRef])

  return { scrollToBottom }
}
