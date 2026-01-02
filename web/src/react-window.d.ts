import React from 'react';

declare module 'react-window' {
    export class VariableSizeList<T = any> extends React.Component<any> {
        scrollToItem(index: number, align?: 'auto' | 'smart' | 'center' | 'end' | 'start'): void;
    }
    export class FixedSizeList<T = any> extends React.Component<any> {
        scrollToItem(index: number, align?: 'auto' | 'smart' | 'center' | 'end' | 'start'): void;
    }
}
