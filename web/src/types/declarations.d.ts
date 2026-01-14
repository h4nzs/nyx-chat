// Shim untuk react-window
declare module 'react-window' {
  import { Component, CSSProperties, Ref } from 'react';

  export type Align = 'auto' | 'smart' | 'center' | 'end' | 'start';
  export type ListOnScrollProps = {
    scrollDirection: 'forward' | 'backward';
    scrollOffset: number;
    scrollUpdateWasRequested: boolean;
  };

  export interface FixedSizeListProps {
    children: React.ComponentType<any>;
    className?: string;
    direction?: 'horizontal' | 'vertical';
    height: number | string;
    initialScrollOffset?: number;
    innerRef?: Ref<any>;
    itemCount: number;
    itemKey?: (index: number, data: any) => any;
    itemSize: number;
    layout?: 'vertical' | 'horizontal';
    onItemsRendered?: (props: any) => any;
    onScroll?: (props: ListOnScrollProps) => any;
    outerRef?: Ref<any>;
    style?: CSSProperties;
    useIsScrolling?: boolean;
    width: number | string;
    [key: string]: any;
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
