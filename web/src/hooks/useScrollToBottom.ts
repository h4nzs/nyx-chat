/// <reference path="../react-window.d.ts" />
import { RefObject, useCallback } from "react"
import { VariableSizeList } from "react-window"

/**
 * Hook untuk auto-scroll ke bawah pada react-window list
 */
export function useScrollToBottom(listRef: RefObject<VariableSizeList<any>>) {
  const scrollToBottom = useCallback(() => {
    if (!listRef.current) return
    const lastIndex = listRef.current.props.itemCount - 1
    if (lastIndex >= 0) {
      listRef.current.scrollToItem(lastIndex, "end")
    }
  }, [listRef])

  return { scrollToBottom }
}