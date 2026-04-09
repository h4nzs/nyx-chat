// Shim untuk react-window
/* eslint-disable */
declare module 'react-window' {
  import { Component, CSSProperties, Ref } from 'react';

  export type Align = 'auto' | 'smart' | 'center' | 'end' | 'start';
  export type ListOnScrollProps = {
    scrollDirection: 'forward' | 'backward';
    scrollOffset: number;
    scrollUpdateWasRequested: boolean;
  };

  export interface FixedSizeListProps {
    children: React.ComponentType<unknown>;
    className?: string;
    direction?: 'horizontal' | 'vertical';
    height: number | string;
    initialScrollOffset?: number;
    innerRef?: Ref<unknown>;
    itemCount: number;
    itemKey?: (index: number, data: unknown) => unknown;
    itemSize: number;
    layout?: 'vertical' | 'horizontal';
    onItemsRendered?: (props: unknown) => unknown;
    onScroll?: (props: ListOnScrollProps) => unknown;
    outerRef?: Ref<unknown>;
    style?: CSSProperties;
    useIsScrolling?: boolean;
    width: number | string;
    [key: string]: unknown;
  }

  export class FixedSizeList extends Component<FixedSizeListProps> {
    scrollTo(scrollOffset: number): void;
    scrollToItem(index: number, align?: Align): void;
  }

  export class VariableSizeList extends Component<FixedSizeListProps> {
    scrollTo(scrollOffset: number): void;
    scrollToItem(index: number, align?: Align): void;
    resetAfterIndex(index: number, shouldForceUpdate?: boolean): void;
  }
}

// Shim untuk libsodium
declare module 'libsodium-wrappers';
declare module 'libsodium-wrappers-sumo';

declare global {
  interface Window {
    currentReactionHandler?: (emoji: string) => void;
    webkitAudioContext?: typeof AudioContext;
  }
}

