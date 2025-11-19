import '@testing-library/jest-dom';
import { Buffer } from 'buffer';

// Polyfill Buffer for jsdom environment
global.Buffer = Buffer;
