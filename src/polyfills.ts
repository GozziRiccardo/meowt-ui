// src/polyfills.ts

// Shim process.env for browser bundles
;(window as any).process = (window as any).process || { env: {} };

// Optional but helpful: Buffer polyfill for some WalletConnect deps
import { Buffer } from 'buffer';
(window as any).Buffer = (window as any).Buffer || Buffer;
/// <reference types="vite/client" />
